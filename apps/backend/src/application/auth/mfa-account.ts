import { randomUUID, type KeyObject } from 'node:crypto';
import type { ReauthenticateMfaInput, VerifyMfaInput } from '@planner/contracts';
import { generationIdSchema, publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import type { Db, UpdateFilter } from 'mongodb';
import { commandUuid, CommandRecoveryError } from '../command-journal/operation.js';
import { assertChanged, durable } from '../command-journal/records.js';
import { applyCommandEffect } from '../../storage/command-effects.js';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../../storage/schema.js';
import { type AccountRecord } from './accounts.js';
import { tokenDigest } from './credentials.js';
import { matchTotpCounter } from './mfa-crypto.js';
import { isFactorState, type FactorState } from './mfa-records.js';

type MfaAction = 'enabled' | 'disabled' | 'recovery-codes-renewed';

interface FactorAudit {
  id: string;
  action: MfaAction;
  time: Date;
  revision: number;
  credentialsVersion: number;
}

export type MfaAccount = Omit<AccountRecord, 'localAuth'> & {
  localAuth?: NonNullable<AccountRecord['localAuth']> & {
    factor?: FactorState;
    factorAudit?: FactorAudit;
  };
};
export const mfaAccounts = (db: Db) => db.collection<MfaAccount>('users');

export function getFactor(account: AccountRecord) {
  const localAuth = (account as MfaAccount).localAuth;
  if (localAuth?.mfa !== 'totp' || account.requiresMfaEnrollment || !isFactorState(localAuth.factor)) return null;
  return localAuth.factor;
}

export function mfaActorScope(installationId: string, account: AccountRecord) {
  const credentialsVersion = account.localAuth?.credentialsVersion;
  if (!Number.isSafeInteger(credentialsVersion) || credentialsVersion! < 1) {
    throw new CommandRecoveryError('The account has an invalid credential version.');
  }
  return { installationId, generationId: account.generationId, userId: account.id, credentialsVersion: credentialsVersion! };
}

function accountMatch(account: AccountRecord) {
  return {
    _id: workspaceKey(account.generationId, account.id), generationId: account.generationId, id: account.id,
    disabledAt: { $type: 'null' as const }, revision: account.revision,
    'localAuth.credentialsVersion': account.localAuth!.credentialsVersion,
    'localAuth.mfa': account.localAuth!.mfa,
  };
}

export function verifyCurrentFactor(
  key: KeyObject, installationId: string, account: AccountRecord, factor: FactorState,
  input: VerifyMfaInput | ReauthenticateMfaInput, time: Date,
) {
  if ('recoveryCode' in input) {
    const digest = tokenDigest(input.recoveryCode);
    return factor.recoveryDigests.includes(digest) ? { digest } : null;
  }
  const counter = matchTotpCounter(key, {
    installationId, generationId: account.generationId, userId: account.id, factorId: factor.id,
  }, factor.encrypted, input.totpCode, time, factor.greatestCounter);
  return counter === null ? null : { counter };
}

type FactorProof = NonNullable<ReturnType<typeof verifyCurrentFactor>>;

export async function consumeFactor(database: Db, account: AccountRecord, factor: FactorState, proof: FactorProof) {
  const match = { ...accountMatch(account), 'localAuth.factor.id': factor.id };
  const mutation = proof.counter === undefined
    ? await mfaAccounts(database).updateOne({ ...match, 'localAuth.factor.recoveryDigests': factor.recoveryDigests },
      { $set: { 'localAuth.factor.recoveryDigests': factor.recoveryDigests.filter((item) => item !== proof.digest) } }, durable)
    : await mfaAccounts(database).updateOne({ ...match, 'localAuth.factor.greatestCounter': { $lt: proof.counter } },
      { $set: { 'localAuth.factor.greatestCounter': proof.counter } }, durable);
  assertChanged(mutation.matchedCount);
}

export async function applyFactorChange(
  database: Db, installationId: string, account: MfaAccount,
  action: MfaAction, factor: FactorState | null, time: Date, assurance?: FactorProof,
) {
  const version = mfaActorScope(installationId, account).credentialsVersion;
  const credentialsVersion = action === 'recovery-codes-renewed' ? version : version + 1;
  const revision = account.revision + 1;
  if (!revisionSchema.safeParse(revision).success || !Number.isSafeInteger(credentialsVersion)) {
    throw new CommandRecoveryError('The account multifactor version cannot advance.');
  }
  const audit: FactorAudit = { id: randomUUID(), action, time, revision, credentialsVersion };
  const update: UpdateFilter<MfaAccount> = {
    $set: {
      revision, requiresMfaEnrollment: false,
      'localAuth.mfa': factor ? 'totp' : 'none', 'localAuth.credentialsVersion': credentialsVersion,
      'localAuth.factorAudit': audit, ...(factor && { 'localAuth.factor': factor }),
    },
    ...(!factor && { $unset: { 'localAuth.factor': '' } }),
  };
  const matches = {
    ...accountMatch(account),
    accountChange: { $exists: false }, 'localAuth.factorAudit': { $exists: false },
    ...(account.localAuth?.factor && { 'localAuth.factor.id': account.localAuth.factor.id }),
    ...(assurance?.counter !== undefined && { 'localAuth.factor.greatestCounter': { $lt: assurance.counter } }),
    ...(assurance?.digest !== undefined && { 'localAuth.factor.recoveryDigests': assurance.digest }),
  };
  const saved = await mfaAccounts(database).findOneAndUpdate(matches, update, { ...durable, returnDocument: 'after' });
  if (!saved) throw new CommandRecoveryError('The account changed during multifactor enrollment or reauthentication.');
  await finishFactorChange(database, installationId, saved);
}

async function finishFactorChange(database: Db, installationId: string, account: MfaAccount) {
  const audit = account.localAuth?.factorAudit;
  if (!audit || !publicIdSchema.safeParse(audit.id).success || !isStoredDate(audit.time)
      || !revisionSchema.safeParse(audit.revision).success || audit.revision !== account.revision
      || audit.credentialsVersion !== account.localAuth!.credentialsVersion
      || !['enabled', 'disabled', 'recovery-codes-renewed'].includes(audit.action)
      || (audit.action === 'disabled' ? account.localAuth?.mfa !== 'none' || account.localAuth.factor !== undefined : !getFactor(account))) {
    throw new CommandRecoveryError('An account has an invalid multifactor transition.');
  }

  if (audit.action !== 'recovery-codes-renewed') {
    for (const name of ['sessions', 'trustedDevices', 'oauthArtifacts', 'oauthConnections'] as const) {
      await database.collection(name).updateMany({ generationId: account.generationId, userId: account.id, revokedAt: null },
        { $set: { revokedAt: audit.time } }, durable);
    }
    await database.collection('recoveryGrants').updateMany({
      installationId, generationId: account.generationId, userId: account.id, kind: 'account-recovery',
      consumedAt: { $type: 'null' }, revokedAt: { $type: 'null' },
    }, { $set: { revokedAt: audit.time } }, durable);
  }

  const commandId = commandUuid(account.generationId, ['mfa-change', audit.id]);
  await applyCommandEffect(database, account.generationId, {
    kind: 'insert', collection: 'auditEntries', id: commandUuid(commandId, ['audit']),
    effectId: commandUuid(commandId, ['effect', '0']),
    fields: { actorId: account.id, origin: 'web', commandId, resourceId: account.id, resourceType: 'account',
      action: 'mfa.' + audit.action, createdAt: audit.time.toISOString() },
  }, false, async () => {});
  const completed = await mfaAccounts(database).updateOne({
    _id: workspaceKey(account.generationId, account.id), generationId: account.generationId, id: account.id,
    revision: audit.revision, 'localAuth.factorAudit.id': audit.id,
  }, { $unset: { 'localAuth.factorAudit': '' } }, durable);
  assertChanged(completed.matchedCount);
}

function stagedBinding(installation: InstallationDocument) {
  const setup = installation.setup;
  const descriptor = setup?.stagedMfaEnrollment;
  if (installation.activeGenerationId !== null || setup?.mode !== 'import' || setup.pendingAction !== 'migration-preflight'
      || !generationIdSchema.safeParse(setup.enrollmentGenerationId).success || !descriptor
      || !publicIdSchema.safeParse(descriptor.userId).success || !publicIdSchema.safeParse(descriptor.recoveryId).success
      || !Number.isSafeInteger(descriptor.credentialsVersion) || descriptor.credentialsVersion < 1) return null;
  return { ...descriptor, generationId: setup.enrollmentGenerationId! };
}

export async function readStagedMfaEnrollment(database: Db, installationId: string, time: Date) {
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  const scope = stagedBinding(installation);
  if (!scope) return null;
  const grant = await database.collection<{ _id: string; issuedAt: Date; expiresAt: Date; consumedAt: Date }>('recoveryGrants').findOne({
    _id: workspaceKey(scope.generationId, scope.recoveryId), id: scope.recoveryId, installationId,
    generationId: scope.generationId, userId: scope.userId, kind: 'account-recovery',
    targetEpoch: scope.credentialsVersion - 1, revokedAt: { $type: 'null' },
    consumedAt: { $type: 'date', $lte: time }, expiresAt: { $gt: time },
  });
  if (!grant || !isStoredDate(grant.issuedAt) || !isStoredDate(grant.expiresAt) || !isStoredDate(grant.consumedAt)
      || grant.issuedAt > grant.consumedAt || grant.consumedAt >= grant.expiresAt
      || grant.expiresAt.getTime() !== grant.issuedAt.getTime() + 30 * 60_000) return null;
  const account = await mfaAccounts(database).findOne({
    _id: workspaceKey(scope.generationId, scope.userId), generationId: scope.generationId, id: scope.userId,
    disabledAt: { $type: 'null' }, 'localAuth.credentialsVersion': scope.credentialsVersion,
  });
  return account?.role === 'admin' && account.requiresMfaEnrollment ? { scope, account } : null;
}

// During native startup no ordinary operations are admitted while protected effects are replayed.
export async function recoverFactorChanges(database: Db, installationId: string) {
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  const generationId = installation.activeGenerationId ?? stagedBinding(installation)?.generationId;
  if (!generationId) return;
  const pending = await mfaAccounts(database).find({ generationId, 'localAuth.factorAudit': { $exists: true } }, { limit: 2 }).toArray();
  if (pending.length > 1) throw new CommandRecoveryError('Multiple multifactor transitions are pending.');
  if (pending[0]) await finishFactorChange(database, installationId, pending[0]);
}
