import { randomBytes, randomUUID } from 'node:crypto';
import { completedMigrationTable, importRunKey, migrationCursors } from '../../apps/backend/dist/application/migration/checkpoint.js';

export async function publishSyntheticMigration(db, { installationId, generationId, actorId }) {
  const runId = randomUUID();
  const fingerprintSha256 = 'a'.repeat(64);
  const manifestSha256 = 'b'.repeat(64);
  const reportSha256 = 'c'.repeat(64);
  const mfaKeyDigest = 'd'.repeat(64);
  const cursors = migrationCursors(randomBytes(32));
  const position = { pass: 'media', table: completedMigrationTable, lastSourceId: '101' };
  const checkpoint = { ...position, token: cursors.seal({ runId, generationId, fingerprint: fingerprintSha256, ...position }, '101') };
  const current = new Date(Date.now() - 10);
  const prior = { generationId: null, setup: { mode: 'import', pendingAction: 'migration-preflight', enrollmentGenerationId: generationId } };
  const run = { ...importRunKey({ runId, generationId, installationId }), state: 'verified',
    fingerprint: { sha256: fingerprintSha256 }, manifestSha256, createdAt: current, updatedAt: current, checkpoint,
    source: { instanceId: randomUUID(), release: '2.3.1', edition: 'community' }, verification: { reportSha256, detailSha256: '0'.repeat(64) } };
  run.stageCompletion = cursors.sealCompletion(run);
  const binding = { verification: { runId, generationId, manifestSha256, fingerprintSha256, reportSha256, missingOriginals: 0, approvalSha256: null },
    prior, rollback: { kind: 'cold', manifestSha256, fingerprintSha256 },
    administrator: { userId: actorId, credentialsVersion: 1, revision: 1, factorId: null },
    mfaKeyDigest, stageCompletion: run.stageCompletion, schemaVersion: 1 };
  await db.collection('importRuns').insertOne({ ...run, activation: binding });
  await db.collection('installation').updateOne({ _id: 'installation' }, { $set: {
    setup: { mode: 'import', pendingAction: 'complete', enrollmentGenerationId: null }, mfaKeyDigest,
    migrationActivation: { state: 'activeReadOnly', activatedAt: current, binding },
  } });
  return runId;
}
