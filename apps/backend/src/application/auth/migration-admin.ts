import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountEmailSchema, accountNameSchema, type AccountRecoveryInput } from '@planner/contracts';
import { publicIdSchema, revisionSchema, signedInt64TextSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { applyCommandEffect } from '../../storage/command-effects.js';
import { isStoredDate, legacyPublicId, nameBasedUuid, newPublicId, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../../storage/schema.js';
import type { CommandGate } from '../command-gate/gate.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { commandUuid, CommandRecoveryError } from '../command-journal/operation.js';
import { durable } from '../command-journal/records.js';
import { completedMigrationTable, importRunKey, type ImportRun } from '../migration/checkpoint.js';
import { MigrationError } from '../migration/manifest.js';
import type { ImportMap } from '../migration/staged-records.js';
import { accounts, defaultPreferences, getLocalAccount, type AccountRecord } from './accounts.js';
import { recoveryLifetimeMs } from './account-grant.js';
import { AccountActionError, accountEpoch, accountIdentity, accountLookup, checkAccountIdentity, nextAccountRevision, usableAdmin } from './account-policy.js';
import { newToken, tokenDigest } from './credentials.js';
import { getFactor, mfaAccounts } from './mfa-account.js';
import { issueStagedMfaTicket } from './mfa-management.js';
import { hasConsumedStagedProof } from './mfa-records.js';
import { coldMigrationAdminBinding, migrationAdminGrants, readMigrationAdminBinding, readMigrationAdminGrant, sameVerifiedMigration,
  type MigrationAdminBinding, type MigrationAdminGrant } from './migration-admin-grant.js';
import { isPasswordVerifier, type PasswordHasher } from './password.js';

export const migrationAdminRequest = z.union([
  z.strictObject({ runId: publicIdSchema, sourceUserId: signedInt64TextSchema, rotate: z.boolean() }),
  z.strictObject({ runId: publicIdSchema, name: accountNameSchema, email: accountEmailSchema, approveFallback: z.literal(true), rotate: z.boolean() }),
]);
type AdminRequest = z.infer<typeof migrationAdminRequest>;
type FallbackAccount = AccountRecord & { migrationFallback: { runId: string; reportSha256: string } };
const installationRows = (db: Db) => db.collection<InstallationDocument>('installation');

function refuse(message: string) { return new MigrationError('target-setup', message); }
function invalidGrant() { return new AccountActionError('grant'); }
function invalidClaim() { return new CommandRecoveryError('The staged administrator recovery claim does not match the authorized import.'); }

async function audit(db: Db, generationId: string, userId: string, action: string, scope: string, time: Date, origin: 'operator' | 'web') {
  const commandId = commandUuid(generationId, [action, scope]);
  await applyCommandEffect(db, generationId, {
    kind: 'insert', collection: 'auditEntries', id: commandUuid(commandId, ['audit']), effectId: commandUuid(commandId, ['effect', '0']),
    fields: { actorId: userId, origin, commandId, resourceId: userId, resourceType: 'account', action, createdAt: time.toISOString() },
  }, false, async () => {});
}

async function importedAdmin(db: Db, run: ImportRun, sourceUserId: string) {
  const sourceId = signedInt64TextSchema.parse(sourceUserId);
  const userId = legacyPublicId(run.source.instanceId, 'user_account', sourceId);
  const key = accountLookup(run.generationId, userId);
  if (!await db.collection<ImportMap>('importIds').findOne({ ...key, entity: 'user_account', sourceId, sourceInstanceId: run.source.instanceId })) return null;
  return accounts(db).findOne({ ...key, role: 'admin', disabledAt: { $type: 'null' } });
}

async function fallbackAdmin(db: Db, run: ImportRun, input: Extract<AdminRequest, { approveFallback: true }>, time: Date) {
  const { generationId } = run;
  const userId = nameBasedUuid(run.id, 'approved-fallback-admin');
  const key = accountLookup(generationId, userId);
  const users = db.collection<FallbackAccount>('users');
  if (await users.findOne({ generationId, id: { $ne: userId }, role: 'admin', disabledAt: { $type: 'null' } }))
    throw refuse('An enabled imported administrator is available. Select its exact source user ID.');
  const identity = accountIdentity(input.email, null);
  const migrationFallback = { runId: run.id, reportSha256: run.verification!.reportSha256 };
  const existing = await users.findOne(key);
  if (existing) {
    if (!isDeepStrictEqual(existing.migrationFallback, migrationFallback) || existing.role !== 'admin' || existing.disabledAt !== null
      || existing.name !== input.name || existing.email !== identity.email || existing.username !== null)
      throw refuse('The existing fallback administrator does not match this approval.');
    await audit(db, generationId, userId, 'migration.fallback-admin-approved', run.id, existing.createdAt, 'operator');
    return existing;
  }
  await checkAccountIdentity(db, generationId, identity);
  const account: FallbackAccount = { ...key, ...identity, name: input.name, revision: 1, role: 'admin', disabledAt: null, createdAt: time,
    migrationFallback, requiresMfaEnrollment: true, preferences: defaultPreferences,
    localAuth: { passwordVerifier: null, credentialsVersion: 1, mfa: 'enrollment-required' } };
  await users.insertOne(account, durable);
  await audit(db, generationId, userId, 'migration.fallback-admin-approved', run.id, time, 'operator');
  return account;
}

function coldMatch(installation: InstallationDocument) {
  const setup = installation.setup!;
  return { _id: 'installation' as const, installationId: installation.installationId, activeGenerationId: { $type: 'null' as const },
    'setup.mode': 'import' as const, 'setup.pendingAction': 'migration-preflight' as const,
    'setup.enrollmentGenerationId': setup.enrollmentGenerationId === null ? { $type: 'null' as const } : setup.enrollmentGenerationId,
    ...(setup.migrationAdminRecovery ? { 'setup.migrationAdminRecovery.grantId': setup.migrationAdminRecovery.grantId }
      : { 'setup.migrationAdminRecovery': { $exists: false } }) };
}

export async function issueMigrationAdminRecovery(db: Db, lease: WriterLease, run: ImportRun, request: unknown, time = new Date()) {
  lease.assertHeld();
  const parsed = migrationAdminRequest.safeParse(request);
  if (!parsed.success) throw refuse('Specify an exact source identity or explicitly approve a fallback administrator.');
  const input = parsed.data;
  const { installationId, generationId } = run;
  const installed = await readInstallation(db, installationId);
  requireCurrentSchema(installed);
  const prior = coldMigrationAdminBinding(installed);
  if (run.id !== input.runId || !run.verification || run.state !== 'verified' || !run.stageCompletion
    || run.checkpoint?.pass !== 'media' || run.checkpoint.table !== completedMigrationTable || installed.activeGenerationId !== null
    || installed.setup?.mode !== 'import' || installed.setup.pendingAction !== 'migration-preflight'
    || (prior ? !sameVerifiedMigration(run, prior) : installed.setup.enrollmentGenerationId !== null || installed.setup.migrationAdminRecovery !== undefined))
    throw refuse('Select the verified inactive import before designating its administrator.');
  const current = await db.collection<ImportRun>('importRuns').findOne(importRunKey({ runId: run.id, generationId, installationId }));
  if (!isDeepStrictEqual(current, run)) throw refuse('The verified migration changed.');
  const old = prior && await readMigrationAdminGrant(db, installationId, prior);
  if (prior && !old) throw refuse('The previous administrator recovery binding could not be verified.');
  const priorAccount = prior && await mfaAccounts(db).findOne(accountLookup(generationId, prior.userId));
  if (old?.claim || priorAccount?.accountChange || priorAccount?.localAuth?.factorAudit)
    throw refuse('The previous recovery or multifactor change must finish before rotating the grant.');
  if (prior && await readMigrationAdminActivationProof(db, run)) throw refuse('The selected administrator has already completed recovery.');
  if (!prior && input.rotate) throw refuse('There is no designated administrator recovery grant to rotate.');

  const sourceUserId = 'sourceUserId' in input ? input.sourceUserId : null;
  if (prior && sourceUserId !== prior.sourceUserId && (!input.rotate || old?.consumedAt !== null))
    throw refuse('An administrator is already designated. Rotate its unused grant explicitly to change the selection.');
  let user: AccountRecord | null;
  if ('sourceUserId' in input) user = await importedAdmin(db, run, input.sourceUserId);
  else {
    try { user = await fallbackAdmin(db, run, input, time); }
    catch (error) {
      if (error instanceof AccountActionError && error.kind === 'identity') throw refuse('The fallback account conflicts with a staged identity.');
      throw error;
    }
  }
  if (!user || !revisionSchema.safeParse(user.revision).success || accountEpoch(user) < 1 || !user.localAuth
    || (old?.consumedAt === null && user.id === prior?.userId && isPasswordVerifier(user.localAuth.passwordVerifier)))
    throw refuse('Select the exact enabled imported administrator and its protected account state.');
  if (prior && !input.rotate) {
    if (!old || old.binding.userId !== user.id) throw refuse('Rotate the previous administrator recovery grant explicitly.');
    if (old.consumedAt === null && (user.revision !== prior.accountRevision || accountEpoch(user) !== prior.credentialsVersion))
      throw refuse('The designated administrator account changed.');
    await audit(db, generationId, user.id, 'migration.admin-recovery-issued', old.id, old.issuedAt, 'operator');
    return { status: 'already-issued' as const, userId: user.id, expiresAt: old.expiresAt.toISOString() };
  }
  if (await mfaAccounts(db).findOne({ ...accountLookup(generationId, user.id), 'localAuth.factor': { $exists: true } }))
    throw refuse('The designated administrator already has authenticator state.');
  const grantId = newPublicId();
  const token = newToken();
  const binding: MigrationAdminBinding = { runId: run.id, generationId, fingerprintSha256: run.fingerprint.sha256,
    reportSha256: run.verification.reportSha256, manifestSha256: run.manifestSha256,
    stageCompletion: run.stageCompletion, checkpointToken: run.checkpoint.token,
    userId: user.id, sourceUserId, grantId, accountRevision: user.revision,
    credentialsVersion: accountEpoch(user), requiresMfa: user.requiresMfaEnrollment === true || user.localAuth.mfa === 'enrollment-required' };
  const expiresAt = new Date(time.getTime() + recoveryLifetimeMs);
  lease.assertHeld();
  await migrationAdminGrants(db).insertOne({ _id: workspaceKey(generationId, grantId), id: grantId, installationId, generationId,
    userId: user.id, actorId: user.id, targetEpoch: binding.credentialsVersion, kind: 'migration-admin-recovery', binding,
    tokenDigest: tokenDigest(token), issuedAt: time, expiresAt, consumedAt: null, revokedAt: null }, durable);
  lease.assertHeld();
  const published = await installationRows(db).updateOne(coldMatch(installed), {
    $set: { 'setup.enrollmentGenerationId': generationId, 'setup.migrationAdminRecovery': binding },
    $unset: { 'setup.stagedMfaEnrollment': '' },
  }, durable);
  if (published.matchedCount !== 1) throw refuse('The administrator recovery selection changed.');
  await migrationAdminGrants(db).updateMany({ installationId, generationId, kind: 'migration-admin-recovery', id: { $ne: grantId }, revokedAt: null },
    { $set: { revokedAt: time } }, durable);
  await audit(db, generationId, user.id, 'migration.admin-recovery-issued', grantId, time, 'operator');
  return { status: 'issued' as const, userId: user.id, expiresAt: expiresAt.toISOString(), grant: token };
}

async function finishRecovery(db: Db, installationId: string, grant: MigrationAdminGrant) {
  const { binding, claim, consumedAt } = grant;
  if (!claim || !isPasswordVerifier(claim.passwordVerifier) || !isStoredDate(consumedAt) || grant.revokedAt !== null
    || !isDeepStrictEqual(await readMigrationAdminBinding(db, installationId), binding)) throw invalidClaim();
  const { generationId, userId } = binding;
  const key = accountLookup(generationId, userId);
  const revision = nextAccountRevision(binding.accountRevision);
  const credentialsVersion = binding.credentialsVersion + 1;
  if (!Number.isSafeInteger(credentialsVersion)) throw invalidClaim();
  const localAuth = { passwordVerifier: claim.passwordVerifier, credentialsVersion,
    mfa: binding.requiresMfa ? 'enrollment-required' as const : 'none' as const };
  const saved = await accounts(db).updateOne({ ...key, revision: binding.accountRevision, role: 'admin', disabledAt: { $type: 'null' },
    'localAuth.credentialsVersion': binding.credentialsVersion, 'localAuth.factor': { $exists: false } },
  { $set: { localAuth, revision, updatedAt: consumedAt } }, durable);
  if (saved.matchedCount !== 1) {
    const user = await accounts(db).findOne({ ...key, revision, role: 'admin', disabledAt: { $type: 'null' } });
    if (!user || !isDeepStrictEqual(user.localAuth, localAuth)) throw invalidClaim();
  }
  if (binding.requiresMfa) {
    const installed = await readInstallation(db, installationId);
    if (!isDeepStrictEqual(coldMigrationAdminBinding(installed), binding)) throw invalidClaim();
    const savedScope = await installationRows(db).updateOne(coldMatch(installed), {
      $set: { 'setup.stagedMfaEnrollment': { userId, recoveryId: grant.id, accountRevision: revision, credentialsVersion } },
    }, durable);
    if (savedScope.matchedCount !== 1) throw invalidClaim();
  }
  await audit(db, generationId, userId, 'migration.admin-password-recovered', grant.id, consumedAt, 'web');
  const settled = await migrationAdminGrants(db).updateOne({ _id: grant._id, installationId, generationId, id: grant.id,
    kind: grant.kind, consumedAt, revokedAt: { $type: 'null' }, claim }, { $unset: { claim: '' } }, durable);
  if (settled.matchedCount !== 1) throw invalidClaim();
}

export async function recoverMigrationAdmin(db: Db, installationId: string) {
  const binding = await readMigrationAdminBinding(db, installationId);
  if (!binding) return;
  const grant = await readMigrationAdminGrant(db, installationId, binding);
  if (!grant) throw invalidClaim();
  await audit(db, grant.generationId, grant.userId, 'migration.admin-recovery-issued', grant.id, grant.issuedAt, 'operator');
  if (grant.claim) await finishRecovery(db, installationId, grant);
}

export async function canRecoverMigrationAdmin(db: Db, installationId: string, time: Date) {
  const binding = await readMigrationAdminBinding(db, installationId);
  if (!binding) return false;
  const grant = await readMigrationAdminGrant(db, installationId, binding);
  if (!grant || grant.consumedAt !== null || grant.revokedAt !== null || grant.claim || time < grant.issuedAt || time >= grant.expiresAt) return false;
  const account = await accounts(db).findOne({ ...accountLookup(binding.generationId, binding.userId), role: 'admin', disabledAt: { $type: 'null' } });
  return !!account && account.revision === binding.accountRevision && accountEpoch(account) === binding.credentialsVersion;
}

export function consumeMigrationAdminRecovery(db: Db, installationId: string, gate: Pick<CommandGate, 'runCommand'>,
  hasher: PasswordHasher, input: AccountRecoveryInput, now = () => new Date(), afterClaim?: () => Promise<void>) {
  return gate.runCommand(async () => {
    const binding = await readMigrationAdminBinding(db, installationId);
    if (!binding) throw invalidGrant();
    const grant = await readMigrationAdminGrant(db, installationId, binding);
    const time = now();
    if (!grant || !timingSafeEqual(Buffer.from(grant.tokenDigest, 'hex'), Buffer.from(tokenDigest(input.grant), 'hex'))
      || !await canRecoverMigrationAdmin(db, installationId, time)) throw invalidGrant();
    const passwordVerifier = await hasher.encode(input.password);
    const appliedAt = now();
    if (appliedAt < time || appliedAt >= grant.expiresAt) throw invalidGrant();
    const immutable = { _id: grant._id, installationId, generationId: grant.generationId, kind: grant.kind,
      tokenDigest: grant.tokenDigest, consumedAt: { $type: 'null' as const }, revokedAt: { $type: 'null' as const }, claim: { $exists: false } };
    const claimed = await migrationAdminGrants(db).findOneAndUpdate(immutable, {
      $set: { consumedAt: appliedAt, claim: { passwordVerifier } },
    }, { ...durable, returnDocument: 'after' });
    if (!claimed) throw invalidGrant();
    await afterClaim?.();
    await finishRecovery(db, installationId, claimed);
    if (!binding.requiresMfa) return { status: 'confirmed' as const };
    const enrollmentId = await issueStagedMfaTicket(db, installationId, now());
    if (!enrollmentId) throw invalidGrant();
    return { status: 'enrollment-required' as const, enrollmentId };
  });
}

export async function readMigrationAdminActivationProof(db: Db, run: ImportRun) {
  const binding = await readMigrationAdminBinding(db, run.installationId);
  if (!binding || !sameVerifiedMigration(run, binding)) return null;
  const grant = await readMigrationAdminGrant(db, run.installationId, binding);
  if (!grant || grant.revokedAt !== null || !grant.consumedAt || grant.claim) return null;
  const account = await mfaAccounts(db).findOne(accountLookup(binding.generationId, binding.userId));
  if (!account || !usableAdmin(account) || account.localAuth?.factorAudit || account.accountChange) return null;
  const accountRevision = binding.accountRevision + (binding.requiresMfa ? 2 : 1);
  const credentialsVersion = binding.credentialsVersion + (binding.requiresMfa ? 2 : 1);
  if (account.revision !== accountRevision || accountEpoch(account) !== credentialsVersion) return null;
  if (binding.sourceUserId !== null && (await importedAdmin(db, run, binding.sourceUserId))?.id !== account.id) return null;
  if (binding.sourceUserId === null && !await db.collection<FallbackAccount>('users').findOne({ ...accountLookup(binding.generationId, account.id),
    'migrationFallback.runId': run.id, 'migrationFallback.reportSha256': binding.reportSha256 })) return null;
  const auditMatch = { generationId: binding.generationId, actorId: account.id, resourceType: 'account', resourceId: account.id };
  const recoveryCommandId = commandUuid(binding.generationId, ['migration.admin-password-recovered', grant.id]);
  const audits = db.collection('auditEntries');
  if (!await audits.findOne({ ...auditMatch, commandId: recoveryCommandId, action: 'migration.admin-password-recovered' })) return null;
  let factorId: string | null = null;
  if (binding.requiresMfa) {
    const factor = getFactor(account);
    if (!factor) return null;
    const factorProof = await db.collection<{ _id: string; installationId: string; consumedAt: Date }>('recoveryGrants').findOne({
      _id: workspaceKey(binding.generationId, factor.id), installationId: run.installationId, consumedAt: { $type: 'date' },
    });
    if (!factorProof || !isStoredDate(factorProof.consumedAt) || factorProof.consumedAt < grant.consumedAt || factorProof.consumedAt >= grant.expiresAt
      || !await hasConsumedStagedProof(db, { installationId: run.installationId, generationId: binding.generationId,
        userId: account.id, credentialsVersion: binding.credentialsVersion + 1 }, grant.id, factor.id, factorProof.consumedAt)
      || !await audits.findOne({ ...auditMatch, action: 'mfa.enabled', createdAt: factorProof.consumedAt })) return null;
    factorId = factor.id;
  }
  if (!getLocalAccount(account)) return null;
  return { userId: account.id, recoveryId: grant.id, accountRevision, credentialsVersion, factorId };
}
