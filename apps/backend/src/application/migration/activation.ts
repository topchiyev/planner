import { isDeepStrictEqual } from 'node:util';
import { migrationDigestSchema } from '@planner/contracts';
import { generationIdSchema, publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { BSON, type Db } from 'mongodb';
import { z } from 'zod';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../../storage/schema.js';
import { workspaceKey } from '../../storage/identity.js';
import { usableAdmin } from '../auth/account-policy.js';
import { getFactor, mfaAccounts } from '../auth/mfa-account.js';
import { readMigrationAdminActivationProof } from '../auth/migration-admin.js';
import type { Owner } from '../backup/archive.js';
import { archiveRows, bsonRecord, rawRows } from '../backup/records.js';
import { inspectBackup } from '../backup/restore.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { durable } from '../command-journal/records.js';
import { activationExpectationSchema, assertActivationRetry, assertBoundActivationApproval, type ActivationExpectation } from './approval.js';
import { importRunKey, type ImportRun, type migrationCursors } from './checkpoint.js';
import { inspectMigrationCutover, retainMigrationRollback } from './cutover.js';
import { MigrationError } from './manifest.js';

const administratorSchema = z.strictObject({ userId: publicIdSchema, revision: revisionSchema,
  credentialsVersion: z.number().int().positive(), factorId: publicIdSchema.nullable(), recoveryId: publicIdSchema.optional() });
const backupReceiptSchema = z.strictObject({ backupId: publicIdSchema, manifestSha256: migrationDigestSchema });
type Administrator = z.infer<typeof administratorSchema>;
type PendingSetup = NonNullable<InstallationDocument['setup']>;
type PriorRoute = { generationId: string | null; setup: PendingSetup };
type PriorBackup = { path: string; owner: Owner; receipt: z.infer<typeof backupReceiptSchema> };
type RollbackPoint = { kind: 'cold'; manifestSha256: string; fingerprintSha256: string }
  | { kind: 'backup'; backupId: string; manifestSha256: string; generationId: string };
export type MigrationActivationBinding = { verification: ActivationExpectation; prior: PriorRoute; rollback: RollbackPoint;
  administrator: Administrator; mfaKeyDigest: string; stageCompletion: string; schemaVersion: number };
type PublishedActivation = { binding: MigrationActivationBinding; activatedAt: Date };
export type MigrationActivationReceipt = PublishedActivation & ({ state: 'activeReadOnly' }
  | { state: 'writable'; writesEnabledAt: Date; fence?: { commandId: string; at: Date; accountApprovalBatchSha256?: string } }
  | { state: 'rolledBack'; priorState: 'activeReadOnly' | 'writable'; writesEnabledAt?: Date; rolledBackAt: Date });
export type MigrationActivationRequest = { verification: ActivationExpectation; prior: PriorRoute; priorBackup?: PriorBackup;
  administrator: Administrator; mfaKeyDigest: string; approval?: unknown };

function activationFailure() {
  return new MigrationError('activation-conflict', 'The protected activation expectations do not match this verified import and installation.');
}

async function rollbackPoint(db: Db, installation: InstallationDocument, generationId: string | null, backup: PriorBackup | undefined,
  expectation: ActivationExpectation): Promise<RollbackPoint> {
  if (generationId === null) {
    if (backup) throw activationFailure();
    return { kind: 'cold', manifestSha256: expectation.manifestSha256, fingerprintSha256: expectation.fingerprintSha256 };
  }
  if (!backup || !generationIdSchema.safeParse(generationId).success) throw activationFailure();
  const receipt = backupReceiptSchema.safeParse(backup.receipt);
  if (!receipt.success) throw activationFailure();
  try {
    const verified = await inspectBackup(backup.path, backup.owner, receipt.data.manifestSha256);
    try {
      const { manifest } = verified.archive;
      const archived = BSON.deserialize(BSON.serialize(verified.source));
      if (manifest.backupId !== receipt.data.backupId || manifest.installationId !== installation.installationId
        || manifest.activeGenerationId !== generationId || manifest.schemaVersion !== installation.schemaVersion
        || archived.mfaKeyDigest !== installation.mfaKeyDigest || !isDeepStrictEqual(archived.setup, installation.setup)
        || !isDeepStrictEqual(archived.migrationActivation, installation.migrationActivation)
        || !isDeepStrictEqual(archived.restoration, installation.restoration)) throw activationFailure();
      // A backup may predate staging, but its prior active generation must still match exactly.
      for (const part of manifest.collections) {
        if (part.name === 'installation') continue;
        const archive = await verified.archive.collection(part);
        const live = rawRows(db, part.name, generationId);
        try {
          for await (const { record, bytes } of archiveRows(archive, part)) {
            if (record.generationId !== generationId) continue;
            const current = await live.next();
            if (!current || bsonRecord(current).generationId !== generationId || !current.equals(bytes)) throw activationFailure();
          }
          if (await live.next()) throw activationFailure();
        } finally { await Promise.all([archive.close(), live.close()]); }
      }
      return { kind: 'backup', ...receipt.data, generationId };
    } finally { await verified.close(); }
  } catch { throw activationFailure(); }
}

function matchBinding(saved: MigrationActivationBinding, requested: MigrationActivationBinding) {
  assertActivationRetry(saved.verification, requested.verification);
  if (!isDeepStrictEqual(saved, requested)) throw activationFailure();
}

/** Publish the verified route and its immutable receipt in one installation CAS. */
export async function activateVerifiedMigration(db: Db, lease: WriterLease, installationId: string,
  cursors: ReturnType<typeof migrationCursors>, request: MigrationActivationRequest, afterPointer?: () => Promise<void>) {
  lease.assertHeld();
  const parsed = activationExpectationSchema.safeParse(request.verification);
  const administrator = administratorSchema.safeParse(request.administrator);
  if (!parsed.success || !administrator.success || !migrationDigestSchema.safeParse(request.mfaKeyDigest).success) throw activationFailure();
  const expectation = parsed.data;
  const { runId, generationId } = expectation;
  const key = importRunKey({ runId, generationId, installationId });
  const runs = db.collection<ImportRun>('importRuns');
  const run = await runs.findOne(key);
  if (!run || run.rollback !== undefined || run.state !== 'verified' || !run.stageCompletion || run.manifestSha256 !== expectation.manifestSha256
    || run.fingerprint.sha256 !== expectation.fingerprintSha256 || run.verification?.reportSha256 !== expectation.reportSha256
    || (expectation.missingOriginals > 0) !== (expectation.approvalSha256 !== null)) throw activationFailure();
  try { cursors.assertComplete(run); } catch { throw activationFailure(); }
  assertBoundActivationApproval(run.verification, expectation, request.approval);
  const installation = await readInstallation(db, installationId);
  requireCurrentSchema(installation);
  const previous = await inspectMigrationCutover(db, installation);
  const retained = previous && previous.state !== 'rolledBack' ? previous.binding.rollback : null;
  let rollback: RollbackPoint;
  if (retained?.kind === 'backup' && request.prior.generationId !== null) {
    const backup = backupReceiptSchema.safeParse(request.priorBackup?.receipt);
    if (!backup.success) throw activationFailure();
    rollback = { kind: 'backup', ...backup.data, generationId: request.prior.generationId };
  } else {
    rollback = await rollbackPoint(db, installation, request.prior.generationId, request.priorBackup, expectation);
  }
  const binding: MigrationActivationBinding = {
    verification: expectation, administrator: administrator.data, prior: request.prior, rollback,
    stageCompletion: run.stageCompletion, schemaVersion: installation.schemaVersion, mfaKeyDigest: request.mfaKeyDigest,
  };
  if (previous && previous.state !== 'rolledBack') {
    const saved = previous;
    matchBinding(saved.binding, binding);
    if (installation.activeGenerationId !== generationId
      || installation.setup?.mode !== 'import' || installation.setup.pendingAction !== 'complete'
      || installation.mfaKeyDigest !== binding.mfaKeyDigest || !run.activation) throw activationFailure();
    matchBinding(run.activation, binding);
    return saved;
  }
  if (previous?.binding.verification.runId === runId) throw activationFailure();
  if (previous?.state === 'rolledBack') await retainMigrationRollback(db, installationId, previous);
  const setup = installation.setup;
  if (!setup || !isDeepStrictEqual(request.prior.setup, setup) || setup.mode !== 'import'
    || installation.activeGenerationId !== request.prior.generationId || installation.activeGenerationId === generationId
    || installation.mfaKeyDigest !== binding.mfaKeyDigest) throw activationFailure();
  const { userId, revision, credentialsVersion, factorId, recoveryId } = binding.administrator;
  if (binding.prior.generationId === null) {
    const proof = await readMigrationAdminActivationProof(db, run);
    if (!proof || proof.userId !== userId || proof.accountRevision !== revision || proof.credentialsVersion !== credentialsVersion
      || proof.factorId !== factorId || proof.recoveryId !== recoveryId) throw activationFailure();
  } else {
    if (setup.pendingAction !== 'complete' || recoveryId !== undefined || factorId === null) throw activationFailure();
    const admin = await mfaAccounts(db).findOne({ _id: workspaceKey(generationId, userId), id: userId, generationId,
      disabledAt: { $type: 'null' }, revision, 'localAuth.credentialsVersion': credentialsVersion, 'localAuth.factor.id': factorId,
      'localAuth.factorAudit': { $exists: false }, accountChange: { $exists: false } });
    if (!admin || !usableAdmin(admin) || !getFactor(admin)) throw activationFailure();
  }
  if (run.activation) matchBinding(run.activation, binding);
  else {
    lease.assertHeld();
    const saved = await runs.updateOne({ ...key, state: 'verified', manifestSha256: expectation.manifestSha256,
      'fingerprint.sha256': expectation.fingerprintSha256, verification: run.verification,
      stageCompletion: binding.stageCompletion, activation: { $exists: false } }, { $set: { activation: binding } }, durable);
    if (saved.matchedCount !== 1) throw activationFailure();
  }
  const receipt: MigrationActivationReceipt = { state: 'activeReadOnly', binding, activatedAt: new Date() };
  lease.assertHeld();
  const published = await db.collection<InstallationDocument>('installation').updateOne({ _id: 'installation', installationId,
    activeGenerationId: { $type: binding.prior.generationId === null ? 'null' : 'string', $eq: binding.prior.generationId },
    setup, mfaKeyDigest: binding.mfaKeyDigest, schemaVersion: binding.schemaVersion, schemaMigration: { $exists: false },
    migrationActivation: previous ?? { $exists: false }, restoration: { $exists: false } }, {
    $set: { activeGenerationId: generationId, 'setup.pendingAction': 'complete', 'setup.enrollmentGenerationId': null, migrationActivation: receipt },
    $unset: { 'setup.stagedMfaEnrollment': '', 'setup.migrationAdminRecovery': '' },
  }, durable);
  if (published.matchedCount !== 1) throw activationFailure();
  await afterPointer?.();
  return receipt;
}
