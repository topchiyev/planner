import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, unlink, statfs, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { publicIdSchema, generationIdSchema, utcInstantSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { anchoredDirectory, childPath, fdPath, fileChunks, type Owner } from '../application/backup/archive.js';
import type { WriterLease } from '../application/command-gate/writer-lease.js';
import { durable } from '../application/command-journal/records.js';
import { importRunKey, migrationCursors, type ImportRun } from '../application/migration/checkpoint.js';
import { MigrationError, sha256 } from '../application/migration/manifest.js';
import type { inspectMigration, MigrationInput } from '../application/migration/preflight.js';
import { readInstallation, verifyStorageSchema } from '../storage/schema.js';

const root = { uid: 0, gid: 0 };
const stateDirectory = '/var/lib/planner/migration';
const reserve = 512n * 1024n * 1024n;
type Preflight = Awaited<ReturnType<typeof inspectMigration>>;
type Estimate = Preflight['estimates'];
type Capacity = ReturnType<typeof assertMigrationCapacity>;
type Volume = { id: bigint; free: bigint };

export function assertMigrationCapacity(estimate: Estimate, volumes: { mongo: Volume; blobs: Volume; staging: Volume }) {
  // Estimate durable rows, indices and journal/temporary copies separately from media and stage peaks.
  const mongo = (estimate.sourceBytes + estimate.sourceIndexes) * 2n + estimate.sourceRows * 1024n + reserve;
  const blobs = estimate.assetBytes * 2n;
  const staging = estimate.assetBytes + reserve;
  const grouped = new Map<bigint, { required: bigint; free: bigint }>();
  for (const [volume, bytes] of [[volumes.mongo, mongo], [volumes.blobs, blobs], [volumes.staging, staging]] as const) {
    const current = grouped.get(volume.id);
    grouped.set(volume.id, { required: (current?.required ?? 0n) + bytes,
      free: current && current.free < volume.free ? current.free : volume.free });
  }
  if ([...grouped.values()].some(({ required, free }) => free < required))
    throw new MigrationError('target-capacity', 'The Planner data volumes do not have enough free space for the staged import.');
  return { mongoBytes: mongo.toString(), blobBytes: blobs.toString(), stagingBytes: staging.toString() };
}

export async function checkMigrationCapacity(estimate: Estimate) {
  async function volume(path: string) {
    const [info, fs] = await Promise.all([lstat(path, { bigint: true }), statfs(path, { bigint: true })]);
    if (!info.isDirectory()) throw new MigrationError('target-capacity', 'A Planner data volume could not be verified.');
    return { id: info.dev, free: fs.bavail * fs.bsize };
  }
  const [mongo, blobs, staging] = await Promise.all([
    volume('/var/lib/planner/mongodb'), volume('/var/lib/planner/blobs'), volume('/var/lib/planner/staging'),
  ]);
  return assertMigrationCapacity(estimate, { mongo, blobs, staging });
}

export async function assertMigrationTarget(db: Db, installationId: string) {
  await verifyStorageSchema(db, installationId);
  const state = await readInstallation(db, installationId);
  if (state.activeGenerationId !== null || state.setup?.mode !== 'import' || state.setup.pendingAction !== 'migration-preflight'
      || state.setup.enrollmentGenerationId !== null)
    throw new MigrationError('target-setup', 'Complete import-mode setup on an inactive installation before migration preflight.');
}

function publishFailure() {
  return new MigrationError('target-write', 'The protected migration preflight receipt could not be published.');
}

function errno(error: unknown, code: string) {
  return error && typeof error === 'object' && 'code' in error && error.code === code;
}

async function readRecord(directory: FileHandle, name: string, owner: Owner) {
  let file: FileHandle;
  try { file = await open(childPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (errno(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== owner.uid || before.gid !== owner.gid
      || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 || !before.size || before.size > 64 * 1024) throw publishFailure();
    const chunks: Buffer[] = [];
    for await (const chunk of fileChunks(file, before.size)) chunks.push(chunk);
    const after = await file.stat();
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw publishFailure();
    return Buffer.concat(chunks, before.size);
  } finally { await file.close(); }
}

async function writeRecord(directory: FileHandle, name: string, bytes: Buffer) {
  const temp = childPath(directory, '.write-' + randomUUID());
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, childPath(directory, name));
  } finally {
    await unlink(temp).catch((error: unknown) => { if (!errno(error, 'ENOENT')) throw error; });
  }
}

function publicReceipt(runId: string, receipt: Preflight, capacity: Capacity) {
  return {
    runId, manifestSha256: receipt.manifestSha256, state: 'preflighted',
    fingerprintSha256: receipt.fingerprint.sha256,
    sourceRelease: receipt.capture.source.release, sourceEdition: receipt.capture.source.edition,
    capturePostgresVersion: receipt.capture.source.postgresVersion, restoredPostgresVersion: receipt.restoredPostgresVersion,
    assets: receipt.assets, eligibleUnderDefaultPolicy: receipt.assets.missingOriginals === 0,
    rows: receipt.rows, capacity,
  };
}

export async function persistMigrationPreflight(
  lease: WriterLease, db: Db, installationId: string, directory: FileHandle, owner: Owner,
  input: MigrationInput, receipt: Preflight, capacity: Capacity, afterMongo?: () => Promise<void>,
) {
  const { source, asset, capturedAt } = receipt.capture;
  const capture = { source, asset, capturedAt, dump: receipt.dump };
  const id = sha256(Buffer.from(JSON.stringify([
    installationId, receipt.manifestSha256, receipt.fingerprint.sha256,
    input.manifest, input.sourceService, input.assetsRoot ?? null, input.assetService ?? null,
  ])));
  const intent = '.intent-' + id + '.json';
  try {
    lease.assertHeld();
    let bytes = await readRecord(directory, intent, owner);
    if (!bytes) {
      bytes = Buffer.from(JSON.stringify({
        formatVersion: 1, installationId, generationId: randomUUID(), createdAt: new Date().toISOString(),
        checkpointKey: randomBytes(32).toString('base64url'), fingerprint: receipt.fingerprint, capture, inputs: input,
        ...publicReceipt(randomUUID(), receipt, capacity),
      }) + '\n');
      // Keep this private intent discoverable until and after both stores acknowledge the same identities.
      lease.assertHeld();
      await writeRecord(directory, intent, bytes);
    }
    const saved = JSON.parse(bytes.toString());
    const runId = publicIdSchema.parse(saved.runId);
    const generationId = generationIdSchema.parse(saved.generationId);
    const createdAt = new Date(utcInstantSchema.parse(saved.createdAt));
    const storedCapacity = saved.capacity;
    const capacityFields = ['mongoBytes', 'blobBytes', 'stagingBytes'] as const;
    if (runId === generationId || typeof saved.checkpointKey !== 'string'
      || !/^[\w-]{43}$/u.test(saved.checkpointKey)
      || Buffer.from(saved.checkpointKey, 'base64url').toString('base64url') !== saved.checkpointKey
      || typeof saved.restoredPostgresVersion !== 'string' || !/^17(?:\.[0-9]+){0,2}$/u.test(saved.restoredPostgresVersion)
      || !storedCapacity || !capacityFields.every((field) => typeof storedCapacity[field] === 'string'
        && /^(?:0|[1-9][0-9]{0,40})$/u.test(storedCapacity[field]))) throw publishFailure();
    const [mongoBytes, blobBytes, stagingBytes] = capacityFields.map((field) => storedCapacity[field] as string);
    const output = {
      ...publicReceipt(runId, receipt, { mongoBytes, blobBytes, stagingBytes }),
      restoredPostgresVersion: saved.restoredPostgresVersion as string,
    };
    if (!isDeepStrictEqual(saved, {
      formatVersion: 1, installationId, generationId, createdAt: createdAt.toISOString(),
      checkpointKey: saved.checkpointKey, fingerprint: receipt.fingerprint, capture, inputs: input, ...output,
    })) throw publishFailure();
    const name = runId + '.json';
    const published = await readRecord(directory, name, owner);
    if (published && !published.equals(bytes)) throw publishFailure();

    const key = importRunKey({ generationId, installationId, runId });
    const row: ImportRun = {
      ...key, state: 'preflighted', checkpoint: null, manifestSha256: receipt.manifestSha256,
      fingerprint: receipt.fingerprint, createdAt, updatedAt: createdAt,
      source: { instanceId: source.instanceId, release: source.release, edition: source.edition },
    };
    lease.assertHeld();
    await directory.sync();
    lease.assertHeld();
    const runs = db.collection<ImportRun>('importRuns');
    await runs.updateOne(key, { $setOnInsert: row }, { ...durable, upsert: true });
    const savedRun = await runs.findOne(key);
    if (!savedRun) throw publishFailure();
    const { state, checkpoint, updatedAt, ...original } = savedRun;
    const { state: _state, checkpoint: _checkpoint, updatedAt: _updatedAt, ...expected } = row;
    if (!isDeepStrictEqual(original, expected) || !(updatedAt instanceof Date) || !Number.isFinite(updatedAt.valueOf())) throw publishFailure();
    if (state === 'preflighted') {
      if (checkpoint !== null || updatedAt.valueOf() !== createdAt.valueOf()) throw publishFailure();
    } else {
      if (!published || state !== 'staging' || !checkpoint) throw publishFailure();
      const lastSourceId = migrationCursors(Buffer.from(saved.checkpointKey, 'base64url')).open({
        runId, generationId, fingerprint: receipt.fingerprint.sha256, pass: checkpoint.pass, table: checkpoint.table,
      }, checkpoint.token);
      if (lastSourceId !== checkpoint.lastSourceId) throw publishFailure();
    }
    await afterMongo?.();
    lease.assertHeld();
    if (!published) await writeRecord(directory, name, bytes);
    await directory.sync();
    return output;
  } catch { throw publishFailure(); }
}

export async function publishMigrationPreflight(
  lease: WriterLease, db: Db, installationId: string, input: MigrationInput, receipt: Preflight,
) {
  lease.assertHeld();
  await assertMigrationTarget(db, installationId);
  const capacity = await checkMigrationCapacity(receipt.estimates);
  const parent = await anchoredDirectory('/var/lib/planner', root, 0o711);
  try {
    try { await mkdir(join(fdPath(parent), 'migration'), { mode: 0o700 }); }
    catch (error) { if (!errno(error, 'EEXIST')) throw error; }
    await parent.sync();
  } finally { await parent.close(); }
  const directory = await anchoredDirectory(stateDirectory, root, 0o700);
  try { return await persistMigrationPreflight(lease, db, installationId, directory, root, input, receipt, capacity); }
  finally { await directory.close(); }
}
