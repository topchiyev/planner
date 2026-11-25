import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { migrationDigestSchema, type MigrationCapture } from '@planner/contracts';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import type { Db, Filter } from 'mongodb';
import { currentStorageSchema, readInstallation, requireCurrentSchema } from '../../storage/schema.js';
import { workspaceKey } from '../../storage/identity.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { durable } from '../command-journal/records.js';
import type { MigrationActivationBinding } from './activation.js';
import { MigrationError } from './manifest.js';
import { assertVerifiedSourceSnapshot, trackSourceOperation, type VerifiedSourceSnapshot } from './preflight.js';
import type { SourceFingerprint } from './source-fingerprint.js';
import { compareSourceKeys, projectedSourceTables, sourceKey, sourceProjectionVersion, type SourceTable } from './source-projections.js';

export const migrationPasses = ['reserve', 'base', 'edges', 'deferred', 'projections', 'media'] as const;
export const completedMigrationTable = 'user_account' satisfies SourceTable;
export type MigrationPass = typeof migrationPasses[number];
export type ImportIdentity = { installationId: string; runId: string; generationId: string; fingerprint: SourceFingerprint };
type CursorScope = { runId: string; generationId: string; fingerprint: string; pass: MigrationPass; table: SourceTable };

export type MigrationPosition = { pass: MigrationPass; table: SourceTable; lastSourceId: string | null };
export type MigrationCheckpoint = MigrationPosition & { token: string };

export type ImportRun = {
  _id: string; id: string; installationId: string; generationId: string;
  state: 'preflighted' | 'staging' | 'verified' | 'blocked'; fingerprint: SourceFingerprint;
  manifestSha256: string; createdAt: Date; updatedAt: Date; checkpoint: MigrationCheckpoint | null;
  source: Pick<MigrationCapture['source'], 'instanceId' | 'release' | 'edition'>;
  stageCompletion?: string;
  activation?: MigrationActivationBinding;
  verification?: { reportSha256: string; detailSha256: string };
};

function invalid() {
  return new MigrationError('target-write', 'The protected import checkpoint is invalid or out of sequence.');
}

function cursorMessage(scope: CursorScope, lastSourceId: string | null) {
  if (!publicIdSchema.safeParse(scope.runId).success || !generationIdSchema.safeParse(scope.generationId).success
    || !migrationDigestSchema.safeParse(scope.fingerprint).success || !migrationPasses.includes(scope.pass)
    || !projectedSourceTables.includes(scope.table)) throw invalid();
  return Buffer.from(JSON.stringify([sourceProjectionVersion, scope.runId, scope.generationId, scope.fingerprint,
    scope.pass, scope.table, lastSourceId === null ? null : sourceKey(scope.table, lastSourceId)]));
}

export function migrationCursors(secret: Uint8Array) {
  if (secret.byteLength !== 32) throw invalid();
  const key = Buffer.from(secret);
  const mac = (payload: Uint8Array) => createHmac('sha256', key).update('planner-import-checkpoint\0').update(payload).digest();
  function sealCompletion(run: ImportRun) {
    const { checkpoint } = run;
    if (!checkpoint || checkpoint.pass !== 'media' || checkpoint.table !== completedMigrationTable
      || !migrationDigestSchema.safeParse(run.manifestSha256).success) throw invalid();
    return createHmac('sha256', key).update('planner-import-stage-completion\0').update(JSON.stringify([
      currentStorageSchema, sourceProjectionVersion, run.installationId, run.id, run.generationId, run.manifestSha256,
      run.fingerprint, checkpoint,
    ])).digest('hex');
  }
  return {
    sealCompletion,
    assertComplete(run: ImportRun) {
      const saved = migrationDigestSchema.safeParse(run.stageCompletion);
      if (!saved.success || !timingSafeEqual(Buffer.from(saved.data, 'hex'), Buffer.from(sealCompletion(run), 'hex'))) throw invalid();
    },
    seal(scope: CursorScope, lastSourceId: string | null) {
      const payload = cursorMessage(scope, lastSourceId);
      return payload.toString('base64url') + '.' + mac(payload).toString('base64url');
    },
    open(scope: CursorScope, token: string): string | null {
      if (!/^[\w-]{1,512}\.[\w-]{43}$/u.test(token)) throw invalid();
      const [encoded, checksum] = token.split('.');
      const payload = Buffer.from(encoded, 'base64url');
      const signature = Buffer.from(checksum, 'base64url');
      if (payload.toString('base64url') !== encoded || signature.toString('base64url') !== checksum
        || !timingSafeEqual(mac(payload), signature)) throw invalid();
      const decoded: unknown = JSON.parse(payload.toString());
      if (!Array.isArray(decoded) || decoded.length !== 7
        || (decoded[6] !== null && typeof decoded[6] !== 'string')
        || !cursorMessage(scope, decoded[6]).equals(payload)) throw invalid();
      return decoded[6];
    },
  };
}

export function importRunKey(identity: Pick<ImportIdentity, 'runId' | 'generationId' | 'installationId'>) {
  return { _id: workspaceKey(identity.generationId, identity.runId), id: identity.runId,
    installationId: identity.installationId, generationId: identity.generationId };
}

function comparePosition(a: MigrationPosition, b: MigrationPosition) {
  const section = migrationPasses.indexOf(a.pass) - migrationPasses.indexOf(b.pass)
    || projectedSourceTables.indexOf(a.table) - projectedSourceTables.indexOf(b.table);
  if (section) return section;
  if (a.lastSourceId === null || b.lastSourceId === null) return Number(b.lastSourceId === null) - Number(a.lastSourceId === null);
  return compareSourceKeys(a.table, a.lastSourceId, b.lastSourceId);
}

const activeBatches = new WeakSet<WriterLease>();

/** Apply deterministic, acknowledged effects using a verified source snapshot before advancing its exclusive source key. */
export function writeMigrationBatch(lease: WriterLease, db: Db, identity: ImportIdentity,
  snapshot: VerifiedSourceSnapshot, cursors: ReturnType<typeof migrationCursors>, before: MigrationCheckpoint | null, after: MigrationPosition, apply: () => Promise<void>) {
  try {
    lease.assertHeld();
    assertVerifiedSourceSnapshot(snapshot, true);
    if (!isDeepStrictEqual(snapshot.fingerprint, identity.fingerprint))
      throw new MigrationError('source-changed', 'The source snapshot changed. Start a new import run.');
    if (activeBatches.has(lease)) throw invalid();
    return trackSourceOperation(snapshot, async () => {
      activeBatches.add(lease);
      try {
        const checkpoint = (position: MigrationPosition): MigrationCheckpoint => ({
          pass: position.pass, table: position.table, lastSourceId: position.lastSourceId,
          token: cursors.seal({ runId: identity.runId, generationId: identity.generationId, fingerprint: identity.fingerprint.sha256,
            pass: position.pass, table: position.table }, position.lastSourceId),
        });
        const next = checkpoint(after);
        if (before && (!isDeepStrictEqual(before, checkpoint({ pass: before.pass, table: before.table, lastSourceId: before.lastSourceId }))
          || comparePosition(before, after) >= 0)) throw invalid();
        const installation = await readInstallation(db, identity.installationId);
        if (installation.activeGenerationId === identity.generationId
          || installation.setup?.enrollmentGenerationId === identity.generationId) throw invalid();
        const key = importRunKey(identity);
        const records = db.collection<ImportRun>('importRuns');
        const current = await records.findOne(key);
        if (!current || (current.state !== 'preflighted' && current.state !== 'staging')
          || !isDeepStrictEqual(current.fingerprint, identity.fingerprint) || current.stageCompletion !== undefined) throw invalid();
        if (isDeepStrictEqual(current.checkpoint, next)) return next;
        if (!isDeepStrictEqual(current.checkpoint, before)) throw invalid();
        lease.assertHeld();
        assertVerifiedSourceSnapshot(snapshot, true);
        await apply();
        lease.assertHeld();
        assertVerifiedSourceSnapshot(snapshot);
        const match: Filter<ImportRun> = {
          ...key, state: current.state, stageCompletion: { $exists: false }, 'fingerprint.sha256': identity.fingerprint.sha256,
          ...(before ? { 'checkpoint.token': before.token, 'checkpoint.pass': before.pass, 'checkpoint.table': before.table,
            'checkpoint.lastSourceId': before.lastSourceId ?? { $type: 'null' } } : { checkpoint: { $type: 'null' } }),
        };
        const advanced = await records.updateOne(match, { $set: { state: 'staging', checkpoint: next, updatedAt: new Date() } }, durable);
        if (advanced.matchedCount !== 1) throw invalid();
        return next;
      } finally { activeBatches.delete(lease); }
    });
  } catch (error) { return Promise.reject(error); }
}

/** Record completion only after a verified source walk has exhausted the final media table. */
export async function sealMigrationStage(lease: WriterLease, db: Db, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  cursors: ReturnType<typeof migrationCursors>, checkpoint: MigrationCheckpoint | null) {
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot, true);
  const installation = await readInstallation(db, identity.installationId);
  requireCurrentSchema(installation);
  if (installation.activeGenerationId === identity.generationId || installation.setup?.enrollmentGenerationId === identity.generationId)
    throw invalid();
  const key = importRunKey(identity);
  const runs = db.collection<ImportRun>('importRuns');
  const current = await runs.findOne(key);
  if (!current || current.state !== 'staging' || !checkpoint || !isDeepStrictEqual(current.checkpoint, checkpoint)
    || current.manifestSha256 !== snapshot.manifestSha256 || !isDeepStrictEqual(current.fingerprint, identity.fingerprint)
    || !isDeepStrictEqual(current.fingerprint, snapshot.fingerprint)) throw invalid();
  if (current.stageCompletion !== undefined) return cursors.assertComplete(current);
  const stageCompletion = cursors.sealCompletion(current);
  lease.assertHeld();
  const saved = await runs.updateOne({ ...key, state: 'staging', manifestSha256: current.manifestSha256,
    'fingerprint.sha256': identity.fingerprint.sha256, 'checkpoint.token': checkpoint.token, stageCompletion: { $exists: false } },
  { $set: { stageCompletion, updatedAt: new Date() } }, durable);
  if (saved.matchedCount !== 1) throw invalid();
}
