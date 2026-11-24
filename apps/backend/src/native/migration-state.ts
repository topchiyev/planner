import { randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, mkdir, link, unlink, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from 'mongodb';
import { anchoredDirectory, fdPath } from '../application/backup/archive.js';
import type { WriterLease } from '../application/command-gate/writer-lease.js';
import { durable } from '../application/command-journal/records.js';
import { importRunKey, type ImportRun } from '../application/migration/checkpoint.js';
import { MigrationError } from '../application/migration/manifest.js';
import type { inspectMigration, MigrationInput } from '../application/migration/preflight.js';
import { readInstallation, verifyStorageSchema } from '../storage/schema.js';

const root = { uid: 0, gid: 0 };
const stateDirectory = '/var/lib/planner/migration';
const reserve = 512n * 1024n * 1024n;
type Estimate = Awaited<ReturnType<typeof inspectMigration>>['estimates'];
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

export async function publishMigrationPreflight(
  lease: WriterLease, db: Db, installationId: string, input: MigrationInput, receipt: Awaited<ReturnType<typeof inspectMigration>>,
) {
  lease.assertHeld();
  await assertMigrationTarget(db, installationId);
  const capacity = await checkMigrationCapacity(receipt.estimates);
  const runId = randomUUID();
  const generationId = randomUUID();
  const now = new Date();
  const output = {
    runId, manifestSha256: receipt.manifestSha256, state: 'preflighted',
    fingerprintSha256: receipt.fingerprint.sha256,
    sourceRelease: receipt.capture.source.release, sourceEdition: receipt.capture.source.edition,
    capturePostgresVersion: receipt.capture.source.postgresVersion, restoredPostgresVersion: receipt.restoredPostgresVersion,
    assets: receipt.assets, eligibleUnderDefaultPolicy: receipt.assets.missingOriginals === 0,
    rows: receipt.rows, capacity,
  };
  const { source, asset, capturedAt } = receipt.capture;
  const record = JSON.stringify({ formatVersion: 1, installationId, generationId, createdAt: now.toISOString(),
    checkpointKey: randomBytes(32).toString('base64url'), fingerprint: receipt.fingerprint,
    capture: { source, asset, capturedAt, dump: receipt.dump }, inputs: input, ...output }) + '\n';
  const parent = await anchoredDirectory('/var/lib/planner', root, 0o711);
  try {
    try {
      await mkdir(join(fdPath(parent), 'migration'), { mode: 0o700 });
      await parent.sync();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  } finally { await parent.close(); }
  const dir = await anchoredDirectory(stateDirectory, root, 0o700);
  const pending = join(fdPath(dir), '.preflight-' + runId);
  let owned: Stats | undefined;
  try {
    const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      owned = await file.stat();
      await file.writeFile(record);
      await file.sync();
    } finally { await file.close(); }
    lease.assertHeld();
    await db.collection<ImportRun>('importRuns').insertOne({
      ...importRunKey({ generationId, installationId, runId }), state: 'preflighted', checkpoint: null,
      manifestSha256: receipt.manifestSha256, fingerprint: receipt.fingerprint, createdAt: now, updatedAt: now,
    }, durable);
    await link(pending, join(fdPath(dir), runId + '.json'));
    await unlink(pending);
    owned = undefined;
    await dir.sync();
  } catch {
    throw new MigrationError('target-write', 'The protected migration preflight receipt could not be published.');
  } finally {
    try {
      if (owned) {
        const candidate = await lstat(pending).catch(() => undefined);
        if (candidate?.ino === owned.ino && candidate.dev === owned.dev) await unlink(pending);
      }
    } finally { await dir.close(); }
  }
  return output;
}
