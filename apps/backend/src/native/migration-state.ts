import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, rm, unlink, statfs, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { migrationDigestSchema } from '@planner/contracts';
import { publicIdSchema, generationIdSchema, utcInstantSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { anchoredDirectory, childPath, fdPath, fileChunks, type Owner } from '../application/backup/archive.js';
import type { WriterLease } from '../application/command-gate/writer-lease.js';
import { durable } from '../application/command-journal/records.js';
import { importRunKey, migrationCursors, type ImportRun } from '../application/migration/checkpoint.js';
import { activationExpectation, bindMissingOriginals, canonicalMissingOriginals, parseMigrationApproval } from '../application/migration/approval.js';
import { MigrationError, sha256 } from '../application/migration/manifest.js';
import { assertVerifiedSourceSnapshot, parseMigrationInput, type inspectMigration, type MigrationInput,
  type VerifiedSourceSnapshot } from '../application/migration/preflight.js';
import { openMigrationFile } from '../application/migration/prepare.js';
import { completedMigrationTable, stageMigrationWorkspace } from '../application/migration/stage-base.js';
import { withMigrationSnapshot } from '../application/migration/preflight.js';
import type { MigrationMediaTarget } from '../application/migration/media-stage.js';
import type { MigrationVerification } from '../application/migration/verification.js';
import { createPrivateMediaStore, type PrivateMediaStore } from '../storage/blobs/private-store.js';
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

async function readRecord(directory: FileHandle, name: string, owner: Owner, limit = 64 * 1024) {
  let file: FileHandle;
  try { file = await open(childPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (errno(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== owner.uid || before.gid !== owner.gid
      || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 || !before.size || before.size > limit) throw publishFailure();
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
    const { state, checkpoint, updatedAt, verification, verificationStartedAt, stageCompletion, activation, ...original } = savedRun;
    const { state: _state, checkpoint: _checkpoint, updatedAt: _updatedAt, ...expected } = row;
    if (!isDeepStrictEqual(original, expected) || !(updatedAt instanceof Date) || !Number.isFinite(updatedAt.valueOf())) throw publishFailure();
    if (state === 'preflighted') {
      if (checkpoint !== null || stageCompletion !== undefined || activation !== undefined || verification !== undefined || verificationStartedAt !== undefined
        || updatedAt.valueOf() !== createdAt.valueOf()) throw publishFailure();
    } else {
      if (!published || !checkpoint) throw publishFailure();
      const lastSourceId = migrationCursors(Buffer.from(saved.checkpointKey, 'base64url')).open({
        runId, generationId, fingerprint: receipt.fingerprint.sha256, pass: checkpoint.pass, table: checkpoint.table,
      }, checkpoint.token);
      if (lastSourceId !== checkpoint.lastSourceId) throw publishFailure();
      if (stageCompletion !== undefined) migrationCursors(Buffer.from(saved.checkpointKey, 'base64url')).assertComplete(savedRun);
      if (state === 'staging') {
        if (verification !== undefined || verificationStartedAt !== undefined) throw publishFailure();
      } else {
        if (!isCompleteVerificationStart(savedRun) || stageCompletion === undefined) throw publishFailure();
        if (state === 'verifying') {
          if (verification !== undefined) throw publishFailure();
        } else await readMigrationVerification(directory, owner, savedRun);
      }
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
  const directory = await openNativeMigrationDirectory(true);
  try { return await persistMigrationPreflight(lease, db, installationId, directory, root, input, receipt, capacity); }
  finally { await directory.close(); }
}

const reportLimit = 32 * 1024 * 1024;
const reportName = (runId: string) => publicIdSchema.parse(runId) + '.verification.json';
const verificationFailure = () => new MigrationError('verification-incomplete', 'The complete protected migration verification report is unavailable.');

function finalMediaCheckpoint(run: ImportRun) {
  const { checkpoint } = run;
  return checkpoint?.pass === 'media' && checkpoint.table === completedMigrationTable ? checkpoint : null;
}

function isCompleteVerificationStart(run: ImportRun) {
  return !!finalMediaCheckpoint(run) && run.verificationStartedAt instanceof Date && Number.isFinite(run.verificationStartedAt.valueOf())
    && run.verificationStartedAt >= run.createdAt && run.verificationStartedAt <= run.updatedAt;
}

export async function openNativeMigrationDirectory(create = false) {
  if (create) {
    const parent = await anchoredDirectory('/var/lib/planner', root, 0o711);
    try {
      try { await mkdir(join(fdPath(parent), 'migration'), { mode: 0o700 }); }
      catch (error) { if (!errno(error, 'EEXIST')) throw error; }
      await parent.sync();
    } finally { await parent.close(); }
  }
  return anchoredDirectory(stateDirectory, root, 0o700);
}

const serviceResumeRecord = 'application-resume.json';
type ServiceBinding = { installationId: string; appPort: number };
const serviceResumeEvidence = ({ installationId, appPort }: ServiceBinding) => ({ formatVersion: 1, installationId, appPort });

export async function hasMigrationServiceResume(directory: FileHandle, binding: ServiceBinding) {
  const saved = await readRecord(directory, serviceResumeRecord, root);
  if (!saved) return false;
  try { if (isDeepStrictEqual(JSON.parse(saved.toString()), serviceResumeEvidence(binding))) return true; }
  catch { /* Refuse to act on an inconsistent protected record. */ }
  throw new MigrationError('target-write', 'The protected migration service resume intent is unavailable or inconsistent.');
}

export async function recordMigrationServiceResume(directory: FileHandle, binding: ServiceBinding) {
  if (await hasMigrationServiceResume(directory, binding)) return;
  await writeRecord(directory, serviceResumeRecord, Buffer.from(JSON.stringify(serviceResumeEvidence(binding)) + '\n'));
  await directory.sync();
}

export async function clearMigrationServiceResume(directory: FileHandle, binding: ServiceBinding) {
  if (!await hasMigrationServiceResume(directory, binding)) return;
  await unlink(childPath(directory, serviceResumeRecord));
  await directory.sync();
}

export async function dismissNativeMigrationServiceResume(binding: ServiceBinding) {
  let directory: FileHandle;
  try { directory = await openNativeMigrationDirectory(); }
  catch (error) { if (errno(error, 'ENOENT')) return; throw error; }
  try { await clearMigrationServiceResume(directory, binding); }
  finally { await directory.close(); }
}

export async function readProtectedMigrationRun(db: Db, installationId: string, directory: FileHandle, owner: Owner, runId: string) {
  try {
    const bytes = await readRecord(directory, publicIdSchema.parse(runId) + '.json', owner);
    if (!bytes) throw verificationFailure();
    const saved = JSON.parse(bytes.toString());
    const generationId = generationIdSchema.parse(saved.generationId);
    const key = importRunKey({ generationId, installationId, runId });
    const run = await db.collection<ImportRun>('importRuns').findOne(key);
    if (!run || saved.formatVersion !== 1 || saved.installationId !== installationId || saved.runId !== runId
      || run.manifestSha256 !== saved.manifestSha256 || !isDeepStrictEqual(run.fingerprint, saved.fingerprint)
      || saved.fingerprintSha256 !== run.fingerprint.sha256 || saved.capture?.source?.instanceId !== run.source.instanceId
      || saved.capture?.source?.release !== run.source.release || saved.capture?.source?.edition !== run.source.edition
      || typeof saved.checkpointKey !== 'string' || !/^[\w-]{43}$/u.test(saved.checkpointKey)) throw verificationFailure();
    const secret = Buffer.from(saved.checkpointKey, 'base64url');
    if (secret.toString('base64url') !== saved.checkpointKey) throw verificationFailure();
    if (run.checkpoint) {
      const { pass, table, token, lastSourceId } = run.checkpoint;
      if (migrationCursors(secret).open({ runId, generationId, fingerprint: run.fingerprint.sha256, pass, table }, token) !== lastSourceId)
        throw verificationFailure();
    }
    if (!['preflighted', 'staging', 'verifying', 'verified', 'blocked'].includes(run.state)) throw verificationFailure();
    const cursors = migrationCursors(secret);
    if (run.stageCompletion !== undefined) cursors.assertComplete(run);
    return { run, input: parseMigrationInput(saved.inputs), cursors };
  } catch { throw verificationFailure(); }
}

type ProtectedMigrationRun = Awaited<ReturnType<typeof readProtectedMigrationRun>>;

export function publicMigrationStatus(run: ImportRun) {
  const checkpoint = run.checkpoint && { pass: run.checkpoint.pass, table: run.checkpoint.table, lastSourceId: run.checkpoint.lastSourceId };
  return { runId: run.id, generationId: run.generationId, manifestSha256: run.manifestSha256,
    fingerprintSha256: run.fingerprint.sha256, state: run.state, stageComplete: run.stageCompletion !== undefined, checkpoint };
}

export async function stageProtectedMigrationRun(db: Db, lease: WriterLease, saved: ProtectedMigrationRun, owner: Owner,
  sourceConfig: string, objectConfig: string | undefined, media: MigrationMediaTarget, batchSize?: number) {
  lease.assertHeld();
  const { run, input, cursors } = saved;
  if (run.state !== 'preflighted' && run.state !== 'staging')
    throw new MigrationError('target-write', 'Only a preflighted or staging import run can be resumed.');
  const identity = { runId: run.id, installationId: run.installationId, generationId: run.generationId, fingerprint: run.fingerprint };
  await withMigrationSnapshot(input, owner, sourceConfig, objectConfig, {
    expectedManifestSha256: run.manifestSha256, expectedFingerprint: run.fingerprint.sha256,
  }, (snapshot) => stageMigrationWorkspace(db, lease, identity, snapshot, cursors, media, batchSize));
  const current = await db.collection<ImportRun>('importRuns').findOne(importRunKey(identity));
  if (!current) throw verificationFailure();
  cursors.assertComplete(current);
  return publicMigrationStatus(current);
}

function verifyReport(run: ImportRun, report: MigrationVerification) {
  const { summary, checkpoint, reportSha256, details, missing } = report;
  if (summary.formatVersion !== 1 || summary.runId !== run.id || summary.generationId !== run.generationId
    || !isCompleteVerificationStart(run) || summary.verificationStartedAt !== run.verificationStartedAt?.toISOString()
    || summary.manifestSha256 !== run.manifestSha256 || summary.fingerprintSha256 !== run.fingerprint.sha256
    || (summary.outcome !== 'verified' && summary.outcome !== 'blocked') || !isDeepStrictEqual(checkpoint, run.checkpoint)
    || summary.detailCount !== details.length || summary.detailSha256 !== sha256(Buffer.from(JSON.stringify(details)))
    || reportSha256 !== sha256(Buffer.from(JSON.stringify(summary)))) throw verificationFailure();
  const missingFromDetails = canonicalMissingOriginals(details.filter((entry) => entry.table === 'uploaded_file'
    && entry.reasons.includes('missing-original')).map(({ sourceId }) => ({ type: 'uploaded_file', sourceId, reason: 'missing-original' })));
  if ((summary.outcome === 'verified' ? summary.assets.missingOriginals !== missing.length : summary.assets.missingOriginals < missing.length)
    || !isDeepStrictEqual(missingFromDetails, missing)) throw verificationFailure();
}

function verificationBinding(report: MigrationVerification): NonNullable<ImportRun['verification']> {
  return { reportSha256: report.reportSha256, detailSha256: report.summary.detailSha256, ...bindMissingOriginals(report.missing) };
}

export async function readMigrationVerification(directory: FileHandle, owner: Owner, run: ImportRun) {
  try {
    if (run.state !== 'verified' && run.state !== 'blocked') throw verificationFailure();
    const bytes = await readRecord(directory, reportName(run.id), owner, reportLimit);
    if (!bytes) throw verificationFailure();
    const report = JSON.parse(bytes.toString()) as MigrationVerification;
    verifyReport(run, report);
    if (run.state !== report.summary.outcome || !isDeepStrictEqual(run.verification, verificationBinding(report))) throw verificationFailure();
    return report;
  } catch { throw verificationFailure(); }
}

export function publicMigrationVerification(report: MigrationVerification) {
  return { ...report.summary, reportSha256: report.reportSha256 };
}

export function migrationVerificationPage(report: MigrationVerification, offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw verificationFailure();
  const details = report.details.slice(offset, offset + limit);
  const after = offset + details.length;
  return { ...publicMigrationVerification(report), details, nextOffset: after < report.details.length ? after : null };
}

export async function beginMigrationVerification(lease: WriterLease, db: Db, run: ImportRun, snapshot: VerifiedSourceSnapshot, cursors: ReturnType<typeof migrationCursors>) {
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot, true);
  const checkpoint = finalMediaCheckpoint(run);
  try { cursors.assertComplete(run); } catch { throw verificationFailure(); }
  if (!checkpoint || run.verification !== undefined || (run.state !== 'staging' && run.state !== 'verifying')) throw verificationFailure();
  if (!isDeepStrictEqual(run.fingerprint, snapshot.fingerprint) || run.manifestSha256 !== snapshot.manifestSha256
    || run.source.instanceId !== snapshot.capture.sourceInstanceId) throw verificationFailure();
  const remaining = await snapshot.readBatch(completedMigrationTable, checkpoint.lastSourceId, 1);
  if (remaining.rows.length !== 0 || remaining.hasMore) throw verificationFailure();
  const installation = await readInstallation(db, run.installationId);
  if (installation.activeGenerationId === run.generationId || installation.setup?.enrollmentGenerationId === run.generationId)
    throw verificationFailure();
  const key = importRunKey({ runId: run.id, generationId: run.generationId, installationId: run.installationId });
  const runs = db.collection<ImportRun>('importRuns');
  const current = await runs.findOne(key);
  if (!current || !isDeepStrictEqual(current, run)) throw verificationFailure();
  if (run.state === 'verifying') {
    if (!isCompleteVerificationStart(run)) throw verificationFailure();
    return run;
  }
  const started = new Date();
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot, true);
  const next = await runs.findOneAndUpdate({ ...key, state: 'staging', 'fingerprint.sha256': run.fingerprint.sha256,
    manifestSha256: run.manifestSha256, 'checkpoint.token': checkpoint.token, stageCompletion: run.stageCompletion, verificationStartedAt: { $exists: false },
    verification: { $exists: false } }, { $set: { state: 'verifying', verificationStartedAt: started, updatedAt: started } },
  { ...durable, returnDocument: 'after' });
  if (!next) throw verificationFailure();
  return next;
}

export async function persistMigrationVerification(lease: WriterLease, db: Db, directory: FileHandle, owner: Owner,
  run: ImportRun, report: MigrationVerification, beforePublish?: () => Promise<void>) {
  lease.assertHeld();
  verifyReport(run, report);
  const checkpoint = finalMediaCheckpoint(run);
  if (run.state !== 'verifying' || run.stageCompletion === undefined || !checkpoint || run.verification !== undefined) throw verificationFailure();
  const installation = await readInstallation(db, run.installationId);
  if (installation.activeGenerationId === run.generationId || installation.setup?.enrollmentGenerationId === run.generationId)
    throw verificationFailure();
  const bytes = Buffer.from(JSON.stringify(report) + '\n');
  if (bytes.length > reportLimit) throw new MigrationError('verification-incomplete', 'The protected verification detail inventory exceeds its supported size.');
  const name = reportName(run.id);
  const previous = await readRecord(directory, name, owner, reportLimit);
  // An uncommitted report can be replaced after a recoverable interruption. A committed one is bound by the CAS.
  const key = importRunKey({ runId: run.id, generationId: run.generationId, installationId: run.installationId });
  const runs = db.collection<ImportRun>('importRuns');
  const current = await runs.findOne(key);
  if (!current) throw verificationFailure();
  if (current.state === 'verified' || current.state === 'blocked') return readMigrationVerification(directory, owner, current);
  if (!isDeepStrictEqual(current, run)) throw verificationFailure();
  lease.assertHeld();
  if (!previous?.equals(bytes)) await writeRecord(directory, name, bytes);
  await directory.sync();
  await beforePublish?.();
  lease.assertHeld();
  const result = await runs.updateOne({ ...key, state: 'verifying', 'fingerprint.sha256': run.fingerprint.sha256,
    manifestSha256: run.manifestSha256, 'checkpoint.token': checkpoint.token, stageCompletion: run.stageCompletion, verificationStartedAt: run.verificationStartedAt,
    verification: { $exists: false } }, {
    $set: { state: report.summary.outcome, verification: verificationBinding(report), updatedAt: new Date() },
  }, durable);
  if (result.matchedCount !== 1) throw verificationFailure();
  return report;
}

export async function readMigrationApproval(path: string, owner: Owner = root): Promise<unknown> {
  try {
    const { file, stat } = await openMigrationFile(path, owner);
    try {
      if (stat.size > reportLimit || stat.size === 0) throw new Error('Invalid size.');
      const chunks: Buffer[] = [];
      for await (const chunk of fileChunks(file, stat.size)) chunks.push(chunk);
      const after = await file.stat();
      if (after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs) throw new Error('Approval changed.');
      return parseMigrationApproval(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, stat.size)));
    } finally { await file.close(); }
  } catch { throw new MigrationError('approval-invalid', 'The local approval file could not be verified.'); }
}

export async function prepareMigrationActivation(directory: FileHandle, owner: Owner, run: ImportRun,
  manifestSha256: string, approvalPath?: string) {
  const report = await readMigrationVerification(directory, owner, run);
  if (report.summary.outcome !== 'verified') throw new MigrationError('verification-blocked', 'This import has blocking reconciliation findings.');
  const approval = approvalPath === undefined ? undefined : await readMigrationApproval(approvalPath, owner);
  const { runId, generationId, fingerprintSha256 } = report.summary;
  return activationExpectation({ runId, generationId, fingerprintSha256, manifestSha256: run.manifestSha256,
    reportSha256: report.reportSha256 }, report.missing, migrationDigestSchema.parse(manifestSha256), approval);
}
