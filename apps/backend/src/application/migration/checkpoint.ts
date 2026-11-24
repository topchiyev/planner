import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { migrationDigestSchema } from '@planner/contracts';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import type { Db, Filter } from 'mongodb';
import { readInstallation } from '../../storage/schema.js';
import { workspaceKey } from '../../storage/identity.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { durable } from '../command-journal/records.js';
import { MigrationError } from './manifest.js';
import { assertVerifiedSourceSnapshot, type VerifiedSourceSnapshot } from './preflight.js';
import type { SourceFingerprint } from './source-fingerprint.js';
import { compareSourceKeys, projectedSourceTables, sourceKey, sourceProjectionVersion, type SourceTable } from './source-projections.js';

const passes = ['reserve', 'base', 'edges', 'deferred', 'projections'] as const;
export type MigrationPass = typeof passes[number];
export type ImportIdentity = { installationId: string; runId: string; generationId: string; fingerprint: SourceFingerprint };
type CursorScope = { runId: string; generationId: string; fingerprint: string; pass: MigrationPass; table: SourceTable };

type Position = { pass: MigrationPass; table: SourceTable; lastSourceId: string | null };
type Checkpoint = Position & { token: string };

export type ImportRun = {
  _id: string; id: string; installationId: string; generationId: string;
  state: 'preflighted' | 'staging'; fingerprint: SourceFingerprint;
  manifestSha256: string; createdAt: Date; updatedAt: Date; checkpoint: Checkpoint | null;
};

function invalid() {
  return new MigrationError('target-write', 'The protected import checkpoint is invalid or out of sequence.');
}

function cursorMessage(scope: CursorScope, lastSourceId: string | null) {
  if (!publicIdSchema.safeParse(scope.runId).success || !generationIdSchema.safeParse(scope.generationId).success
    || !migrationDigestSchema.safeParse(scope.fingerprint).success || !passes.includes(scope.pass)
    || !projectedSourceTables.includes(scope.table)) throw invalid();
  return Buffer.from(JSON.stringify([sourceProjectionVersion, scope.runId, scope.generationId, scope.fingerprint,
    scope.pass, scope.table, lastSourceId === null ? null : sourceKey(scope.table, lastSourceId)]));
}

export function migrationCursors(secret: Uint8Array) {
  if (secret.byteLength !== 32) throw invalid();
  const key = Buffer.from(secret);
  const mac = (payload: Uint8Array) => createHmac('sha256', key).update('planner-import-checkpoint\0').update(payload).digest();
  return {
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

function comparePosition(a: Position, b: Position) {
  const section = passes.indexOf(a.pass) - passes.indexOf(b.pass)
    || projectedSourceTables.indexOf(a.table) - projectedSourceTables.indexOf(b.table);
  if (section) return section;
  if (a.lastSourceId === null || b.lastSourceId === null) return Number(b.lastSourceId === null) - Number(a.lastSourceId === null);
  return compareSourceKeys(a.table, a.lastSourceId, b.lastSourceId);
}

/** Apply deterministic, acknowledged effects using a verified source snapshot before advancing its exclusive source key. */
export async function writeMigrationBatch(lease: WriterLease, db: Db, identity: ImportIdentity,
  snapshot: VerifiedSourceSnapshot, cursors: ReturnType<typeof migrationCursors>, before: Checkpoint | null, after: Position, apply: () => Promise<void>) {
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot);
  if (!isDeepStrictEqual(snapshot.fingerprint, identity.fingerprint))
    throw new MigrationError('source-changed', 'The source snapshot changed. Start a new import run.');
  const checkpoint = (position: Position): Checkpoint => ({
    ...position,
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
    || !isDeepStrictEqual(current.fingerprint, identity.fingerprint)) throw invalid();
  if (isDeepStrictEqual(current.checkpoint, next)) return next;
  if (!isDeepStrictEqual(current.checkpoint, before)) throw invalid();
  await apply();
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot);
  const match: Filter<ImportRun> = { ...key, state: current.state, 'fingerprint.sha256': identity.fingerprint.sha256,
    checkpoint: before ?? { $type: 'null' } };
  const advanced = await records.updateOne(match, { $set: { state: 'staging', checkpoint: next, updatedAt: new Date() } }, durable);
  if (advanced.matchedCount !== 1) throw invalid();
  return next;
}
