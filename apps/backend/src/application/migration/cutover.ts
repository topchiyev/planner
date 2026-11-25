import { isDeepStrictEqual } from 'node:util';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../../storage/schema.js';
import { CleanCommandRejection } from '../command-gate/gate.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { CommandRecoveryError } from '../command-journal/operation.js';
import { checkCommand, commands, durable, type CommandRecord } from '../command-journal/records.js';
import type { MigrationActivationReceipt } from './activation.js';
import { importRunKey, type ImportRun } from './checkpoint.js';
import { MigrationError } from './manifest.js';

export class WorkspaceReadOnly extends CleanCommandRejection {
  readonly statusCode = 409;
  readonly code = 'WORKSPACE_READ_ONLY';
  constructor() { super('Workspace writes are paused during migration cutover.'); }
}

function inconsistent(): never {
  throw new CommandRecoveryError('The published migration route or first-write fence is inconsistent.');
}

function conflict(): never {
  throw new MigrationError('activation-conflict', 'The selected run or generation does not match the published migration route.');
}

function restoredSetup(receipt: MigrationActivationReceipt) {
  const prior = receipt.binding.prior;
  if (prior.generationId !== null) return prior.setup;
  return { mode: 'import', pendingAction: 'migration-preflight', enrollmentGenerationId: null } as const;
}

/** Validate the active route against the independently stored immutable import binding. */
export async function inspectMigrationCutover(db: Db, installation: InstallationDocument) {
  const receipt = installation.migrationActivation;
  if (receipt === undefined) return null;
  if (!receipt || !['activeReadOnly', 'writable', 'rolledBack'].includes(receipt.state) || !receipt.binding
    || !isStoredDate(receipt.activatedAt)) return inconsistent();
  const { verification, prior, rollback, schemaVersion, mfaKeyDigest, stageCompletion } = receipt.binding;
  if (!verification || !prior || !rollback || !publicIdSchema.safeParse(verification.runId).success
    || !generationIdSchema.safeParse(verification.generationId).success || schemaVersion !== installation.schemaVersion
    || mfaKeyDigest !== installation.mfaKeyDigest) return inconsistent();
  const restoration = installation.restoration as { phase?: unknown; generationId?: unknown; fingerprint?: unknown; proof?: unknown } | undefined;
  if (restoration !== undefined && (restoration?.phase !== 'active' || restoration.generationId !== installation.activeGenerationId
    || typeof restoration.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(restoration.fingerprint)
    || typeof restoration.proof !== 'string' || !/^[a-f0-9]{64}$/u.test(restoration.proof))) return inconsistent();
  const key = importRunKey({ ...verification, installationId: installation.installationId });
  const run = await db.collection<ImportRun>('importRuns').findOne(key);
  if (!run || run.state !== 'verified' || !isDeepStrictEqual(run.activation, receipt.binding)
    || run.stageCompletion !== stageCompletion || run.manifestSha256 !== verification.manifestSha256
    || run.fingerprint?.sha256 !== verification.fingerprintSha256 || run.verification?.reportSha256 !== verification.reportSha256) return inconsistent();
  if (receipt.state === 'rolledBack') {
    if ((run.rollback !== undefined && !isDeepStrictEqual(run.rollback, receipt)) || !isStoredDate(receipt.rolledBackAt) || receipt.rolledBackAt < receipt.activatedAt
      || installation.activeGenerationId !== prior.generationId || !isDeepStrictEqual(installation.setup, restoredSetup(receipt))) return inconsistent();
    return receipt;
  }
  if (run.rollback !== undefined || installation.activeGenerationId !== verification.generationId || installation.setup?.mode !== 'import'
    || installation.setup.pendingAction !== 'complete' || installation.setup.stagedMfaEnrollment !== undefined
    || installation.setup.migrationAdminRecovery !== undefined) return inconsistent();
  if (receipt.state === 'writable') {
    if (!isStoredDate(receipt.writesEnabledAt) || receipt.writesEnabledAt < receipt.activatedAt) return inconsistent();
    if ('fence' in receipt) {
      if (!receipt.fence) return inconsistent();
      const { commandId, at } = receipt.fence;
      if (!publicIdSchema.safeParse(commandId).success || !isStoredDate(at) || at < receipt.writesEnabledAt) return inconsistent();
      const command = await fenceCommand(db, verification.generationId, commandId);
      if (command.createdAt < receipt.writesEnabledAt || command.createdAt > at) return inconsistent();
    }
  } else if ('fence' in receipt || 'writesEnabledAt' in receipt) return inconsistent();
  return receipt;
}

async function fenceCommand(db: Db, generationId: string, commandId: string) {
  const command = await commands(db).findOne({ _id: workspaceKey(generationId, commandId), generationId, id: commandId }, { promoteLongs: false });
  if (!command) return inconsistent();
  checkCommand(command);
  return command;
}

export async function assertWorkspaceWritable(db: Db, installationId: string, generationId: string) {
  const installation = await readInstallation(db, installationId);
  requireCurrentSchema(installation);
  if (installation.activeGenerationId !== generationId) return inconsistent();
  const receipt = await inspectMigrationCutover(db, installation);
  if (receipt?.state === 'activeReadOnly') throw new WorkspaceReadOnly();
  return receipt?.state === 'writable' ? receipt : null;
}

export async function assertMigrationCommandAdmission(db: Db, installationId: string, generationId: string, commandId: string) {
  const receipt = await assertWorkspaceWritable(db, installationId, generationId);
  if (receipt?.fence && receipt.fence.commandId !== commandId
    && (await fenceCommand(db, generationId, receipt.fence.commandId)).status === 'building') throw new WorkspaceReadOnly();
}

/** The entire plan and recovery batches have been checked, while the journal is still building. */
export async function establishMigrationFence(db: Db, installationId: string, command: CommandRecord) {
  const receipt = await assertWorkspaceWritable(db, installationId, command.generationId);
  if (!receipt) return false;
  if (receipt.fence) {
    if (receipt.fence.commandId !== command.id && (await fenceCommand(db, command.generationId, receipt.fence.commandId)).status === 'building') {
      return inconsistent();
    }
    return false;
  }
  if (command.status !== 'building' || command.createdAt < receipt.writesEnabledAt) return inconsistent();
  const fence = { commandId: command.id, at: new Date() };
  if (fence.at < command.createdAt) return inconsistent();
  const published = await db.collection<InstallationDocument>('installation').updateOne({ _id: 'installation', installationId,
    activeGenerationId: command.generationId, migrationActivation: receipt }, { $set: { 'migrationActivation.fence': fence } }, durable);
  if (published.matchedCount !== 1) return inconsistent();
  return true;
}

export async function assertMigrationJournalSafe(db: Db, installation: InstallationDocument, generationId: string, command?: CommandRecord) {
  const receipt = await inspectMigrationCutover(db, installation);
  if (!receipt || receipt.state === 'rolledBack' || receipt.binding.verification.generationId !== generationId) return;
  const protectedCommand = command ?? await commands(db).findOne({ generationId, status: { $in: ['prepared', 'committed'] } });
  if (!protectedCommand) return;
  if (receipt.state !== 'writable' || !receipt.fence || protectedCommand.createdAt < receipt.writesEnabledAt) return inconsistent();
  if (receipt.fence.commandId !== protectedCommand.id && (await fenceCommand(db, generationId, receipt.fence.commandId)).status === 'building') return inconsistent();
}

export async function enableMigrationWrites(db: Db, lease: WriterLease, installationId: string, runId: string) {
  lease.assertHeld();
  const installation = await readInstallation(db, installationId);
  requireCurrentSchema(installation);
  const receipt = await inspectMigrationCutover(db, installation);
  if (!receipt || receipt.state === 'rolledBack' || receipt.binding.verification.runId !== runId) return conflict();
  if (receipt.state === 'writable') return receipt;
  await assertMigrationJournalSafe(db, installation, receipt.binding.verification.generationId);
  const next = { ...receipt, state: 'writable' as const, writesEnabledAt: new Date() };
  lease.assertHeld();
  const saved = await db.collection<InstallationDocument>('installation').updateOne({ _id: 'installation', installationId,
    activeGenerationId: installation.activeGenerationId, migrationActivation: receipt }, { $set: { migrationActivation: next } }, durable);
  if (saved.matchedCount !== 1) return conflict();
  return next;
}

export async function retainMigrationRollback(db: Db, installationId: string, receipt: Extract<MigrationActivationReceipt, { state: 'rolledBack' }>) {
  const key = importRunKey({ ...receipt.binding.verification, installationId });
  const runs = db.collection<ImportRun>('importRuns');
  const saved = await runs.updateOne({ ...key, activation: receipt.binding, rollback: { $exists: false } }, { $set: { rollback: receipt } }, durable);
  if (saved.matchedCount !== 1) {
    const run = await runs.findOne(key);
    if (!run || !isDeepStrictEqual(run.rollback, receipt)) return inconsistent();
  }
}

export async function rollbackMigration(db: Db, lease: WriterLease, installationId: string, expectedGenerationId: string) {
  lease.assertHeld();
  const installation = await readInstallation(db, installationId);
  requireCurrentSchema(installation);
  const receipt = await inspectMigrationCutover(db, installation);
  if (!receipt || receipt.binding.verification.generationId !== expectedGenerationId) return conflict();
  if (receipt.state === 'rolledBack') {
    await retainMigrationRollback(db, installationId, receipt);
    return receipt;
  }
  if ((receipt.state === 'writable' && receipt.fence) || await commands(db).findOne({ generationId: expectedGenerationId,
    status: { $in: ['prepared', 'committed'] } }, { projection: { _id: 1 } })) {
    throw new MigrationError('rollback-fenced', 'Export the Planner recovery backup and reconcile its edits before changing routing.');
  }
  const next = { state: 'rolledBack' as const, priorState: receipt.state, binding: receipt.binding,
    activatedAt: receipt.activatedAt, rolledBackAt: new Date(),
    ...(receipt.state === 'writable' && { writesEnabledAt: receipt.writesEnabledAt }) };
  lease.assertHeld();
  const saved = await db.collection<InstallationDocument>('installation').updateOne({ _id: 'installation', installationId,
    activeGenerationId: expectedGenerationId, migrationActivation: receipt }, { $set: { migrationActivation: next,
      activeGenerationId: receipt.binding.prior.generationId, setup: restoredSetup(receipt) } }, durable);
  if (saved.matchedCount !== 1) return conflict();
  await retainMigrationRollback(db, installationId, next);
  return next;
}
