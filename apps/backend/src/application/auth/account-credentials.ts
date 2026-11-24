import { isDeepStrictEqual } from 'node:util';
import {
  accountApprovalSchema, accountApprovalActionSchema, accountApprovalResultSchema,
  type AccountApprovalAction, type AccountRecoveryInput, type PasswordChange,
} from '@planner/contracts';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { applyCommandEffect } from '../../storage/command-effects.js';
import { isStoredDate, newPublicId, workspaceKey } from '../../storage/identity.js';
import type { CommandGate } from '../command-gate/gate.js';
import { commandUuid, CommandRecoveryError } from '../command-journal/operation.js';
import { assertChanged, durable } from '../command-journal/records.js';
import { accountById, accountEpoch, accountLookup, AccountActionError, nextAccountRevision, protectLastAdmin, requireSiteAdmin, usableAdmin } from './account-policy.js';
import { accounts, type AccountRecord } from './accounts.js';
import { newToken, tokenDigest } from './credentials.js';
import { isPasswordVerifier, type PasswordHasher } from './password.js';
import { activeAccountGeneration, loadCurrentBrowserSession } from './sessions.js';

const approvalLifetimeMs = 10 * 60_000;
const recoveryLifetimeMs = 30 * 60_000;

interface ProtectedGrant {
  _id: string;
  id: string;
  installationId: string;
  generationId: string;
  userId: string;
  actorId: string;
  targetEpoch: number;
  tokenDigest: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

interface Approval extends ProtectedGrant {
  kind: 'account-approval';
  actorEpoch: number;
  targetRevision: number;
  change: AccountApprovalAction;
}

interface RecoveryGrant extends ProtectedGrant {
  kind: 'account-recovery';
  actorEpoch: number;
  targetRevision: number;
}

export interface AccountChange {
  id: string;
  actorId: string;
  kind: 'role' | 'availability' | 'reset-issued' | 'reset-consumed' | 'password-changed';
  origin: 'web' | 'operator';
  appliedAt: Date;
  revision: number;
  epoch: number;
  approval?: Pick<Approval, 'id' | 'actorEpoch' | 'targetEpoch' | 'change'>;
  recovery?: { id: string; digest: string; actorEpoch: number };
  recoveryId?: string;
}

const approvals = (db: Db) => db.collection<Approval>('recoveryGrants');
const recoveryGrants = (db: Db) => db.collection<RecoveryGrant>('recoveryGrants');
const liveGrant = (time: Date) => ({
  consumedAt: { $type: 'null' as const }, revokedAt: { $type: 'null' as const }, issuedAt: { $lte: time }, expiresAt: { $gt: time },
});
const validId = (id: unknown) => publicIdSchema.safeParse(id).success;
const validEpoch = (epoch: unknown) => Number.isSafeInteger(epoch) && Number(epoch) >= 0;

function describeApproval(approval: Approval) {
  return accountApprovalSchema.parse({
    id: approval.id, actorId: approval.actorId, targetId: approval.userId, revision: approval.targetRevision,
    change: approval.change, expiresAt: approval.expiresAt.toISOString(),
  });
}

function grantIdentity(grant: ProtectedGrant) {
  return { _id: grant._id, id: grant.id, generationId: grant.generationId, installationId: grant.installationId };
}

function checkGrant(grant: ProtectedGrant, lifetime: number) {
  if (!validId(grant.id) || !validId(grant.actorId) || !validId(grant.userId) || !validEpoch(grant.targetEpoch)
      || grant._id !== workspaceKey(grant.generationId, grant.id) || !/^[0-9a-f]{64}$/u.test(grant.tokenDigest)
      || !isStoredDate(grant.issuedAt) || !isStoredDate(grant.expiresAt)
      || grant.expiresAt.getTime() !== grant.issuedAt.getTime() + lifetime) {
    throw new CommandRecoveryError('An account grant has invalid protected state.');
  }
}

function inspectChange(account: AccountRecord) {
  const change = account.accountChange;
  if (!change || !validId(change.id) || !validId(change.actorId) || !isStoredDate(change.appliedAt)
      || account._id !== workspaceKey(account.generationId, account.id)
      || !revisionSchema.safeParse(change.revision).success || change.revision !== account.revision
      || !validEpoch(change.epoch) || change.epoch !== accountEpoch(account)
      || !['role', 'availability', 'reset-issued', 'reset-consumed', 'password-changed'].includes(change.kind)) {
    throw new CommandRecoveryError('An account transition has invalid protected state.');
  }
  const operator = ['role', 'availability', 'reset-issued'].includes(change.kind);
  if (change.origin !== (operator ? 'operator' : 'web')
      || (operator ? !change.approval || change.approval.id !== change.id
        || !validEpoch(change.approval.actorEpoch) || !validEpoch(change.approval.targetEpoch)
        || !accountApprovalActionSchema.safeParse(change.approval.change).success : change.approval !== undefined)
      || (!operator && change.actorId !== account.id)
      || ((change.kind === 'reset-consumed') ? !validId(change.recoveryId) || change.recoveryId !== change.id : change.recoveryId !== undefined)
      || (change.kind === 'reset-issued'
        ? !change.recovery || !validId(change.recovery.id) || !/^[0-9a-f]{64}$/u.test(change.recovery.digest)
          || !validEpoch(change.recovery.actorEpoch)
        : change.recovery !== undefined)
      || (['reset-consumed', 'password-changed'].includes(change.kind) && !isPasswordVerifier(account.localAuth?.passwordVerifier))) {
    throw new CommandRecoveryError('An account transition has an invalid action or identity.');
  }
  return change;
}

async function verifyAppliedApproval(db: Db, installationId: string, account: AccountRecord, change: AccountChange) {
  const claimed = change.approval!;
  const { generationId, id: userId } = account;
  const time = change.appliedAt;
  const approval = await approvals(db).findOne({
    _id: workspaceKey(generationId, claimed.id), id: claimed.id, generationId, installationId, userId,
    kind: 'account-approval', actorId: change.actorId, targetRevision: change.revision - 1,
  });
  if (!approval) throw new CommandRecoveryError('The account approval disappeared.');
  checkGrant(approval, approvalLifetimeMs);
  if (approval.actorEpoch !== claimed.actorEpoch || approval.targetEpoch !== claimed.targetEpoch
      || !isDeepStrictEqual(approval.change, claimed.change) || time < approval.issuedAt || time >= approval.expiresAt
      || approval.revokedAt !== null || (approval.consumedAt !== null && !isDeepStrictEqual(approval.consumedAt, time))) {
    throw new CommandRecoveryError('The applied account change does not match the recorded approval.');
  }
  const action = approval.change;
  const expectedEpoch = approval.targetEpoch + (action.action === 'role' ? 0 : 1);
  const matches = action.action === 'role' ? change.kind === 'role' && account.role === action.role
    : action.action === 'availability' ? change.kind === 'availability' && isDeepStrictEqual(account.disabledAt, action.disabled ? time : null)
    : change.kind === 'reset-issued' && account.disabledAt === null && account.localAuth?.passwordVerifier === null
      && change.recovery?.actorEpoch === approval.actorEpoch;
  if (!matches || change.epoch !== expectedEpoch) {
    throw new CommandRecoveryError('The account state does not match the recorded approval.');
  }
  return approval;
}

async function finishAccountChange(db: Db, installationId: string, account: AccountRecord) {
  const change = inspectChange(account);
  const { generationId, id: userId } = account;
  const scope = { generationId, installationId };
  const time = change.appliedAt;
  const approval = change.approval && await verifyAppliedApproval(db, installationId, account, change);

  if (change.recoveryId) {
    const grant = await recoveryGrants(db).findOne({
      ...scope, _id: workspaceKey(generationId, change.recoveryId), id: change.recoveryId, userId,
      kind: 'account-recovery', targetEpoch: change.epoch - 1, targetRevision: change.revision - 1,
      revokedAt: { $type: 'null' },
    });
    if (!grant) throw new CommandRecoveryError('The claimed account recovery grant is missing or revoked.');
    checkGrant(grant, recoveryLifetimeMs);
    if (time < grant.issuedAt || time >= grant.expiresAt) throw new CommandRecoveryError('An account recovery claim is stale.');
    const consumed = await recoveryGrants(db).updateOne({
      ...grantIdentity(grant), kind: grant.kind, userId, revokedAt: { $type: 'null' },
      $or: [{ consumedAt: { $type: 'null' } }, { consumedAt: time }],
    }, { $set: { consumedAt: time } }, durable);
    assertChanged(consumed.matchedCount);
  }

  if (change.kind !== 'role') {
    for (const name of ['sessions', 'trustedDevices', 'oauthArtifacts', 'oauthConnections'] as const) {
      await db.collection(name).updateMany({ generationId, userId, revokedAt: null },
        { $set: { revokedAt: time } }, durable);
    }
    await recoveryGrants(db).updateMany({
      ...scope, userId, kind: 'account-recovery', consumedAt: { $type: 'null' }, revokedAt: { $type: 'null' },
      ...(change.recovery && { id: { $ne: change.recovery.id } }),
    }, { $set: { revokedAt: time } }, durable);
  }

  if (change.recovery) {
    const { id, digest, actorEpoch } = change.recovery;
    const grant: RecoveryGrant = {
      ...scope, _id: workspaceKey(generationId, id), id, userId, actorId: change.actorId, actorEpoch,
      targetEpoch: change.epoch, targetRevision: change.revision, kind: 'account-recovery', tokenDigest: digest,
      issuedAt: time, expiresAt: new Date(time.getTime() + recoveryLifetimeMs), consumedAt: null, revokedAt: null,
    };
    const { _id, ...fields } = grant;
    const stored = await recoveryGrants(db).findOneAndUpdate({ ...grantIdentity(grant), kind: grant.kind },
      { $setOnInsert: fields }, { ...durable, upsert: true, returnDocument: 'after' });
    if (!isDeepStrictEqual(stored, grant)) throw new CommandRecoveryError('The account recovery grant conflicts with stored state.');
  }

  const commandId = commandUuid(generationId, ['account-change', change.id]);
  await applyCommandEffect(db, generationId, {
    kind: 'insert', collection: 'auditEntries', id: commandUuid(commandId, ['audit']),
    effectId: commandUuid(commandId, ['effect', '0']),
    fields: { actorId: change.actorId, origin: change.origin, commandId, resourceId: userId,
      resourceType: 'account', action: 'account.' + change.kind, createdAt: time.toISOString() },
  }, false, async () => {});

  if (approval) {
    const consumed = await approvals(db).updateOne({
      ...grantIdentity(approval), kind: approval.kind, actorId: approval.actorId, actorEpoch: approval.actorEpoch,
      userId, targetRevision: approval.targetRevision, targetEpoch: approval.targetEpoch,
      $or: [{ consumedAt: { $type: 'null' } }, { consumedAt: time }],
    }, { $set: { consumedAt: time } }, durable);
    assertChanged(consumed.matchedCount);
  }
  const completed = await accounts(db).updateOne({
    ...accountLookup(generationId, userId), revision: change.revision, 'accountChange.id': change.id,
  }, { $unset: { accountChange: '' } }, durable);
  assertChanged(completed.matchedCount);
}

// The native recovery worker holds the exclusive command gate while finishing private account transitions.
export async function recoverAccountChanges(database: Db, installationId: string) {
  const generationId = await activeAccountGeneration(database, installationId);
  if (!generationId) return;
  const pending = accounts(database).find({ generationId, accountChange: { $exists: true } }, { limit: 2 });
  const [account, extra] = await pending.toArray();
  if (extra) throw new CommandRecoveryError('Multiple account transitions are pending.');
  if (account) await finishAccountChange(database, installationId, account);
}

type ChangeInput = Pick<AccountChange, 'id' | 'actorId' | 'kind' | 'origin' | 'appliedAt' | 'approval' | 'recovery' | 'recoveryId'>;

export function createAccountCredentials(
  database: Db, installationId: string, gate: CommandGate, hasher: PasswordHasher,
  now = () => new Date(), checkpoint?: () => void | Promise<void>,
) {
  async function current(token: string, actorId: string) {
    const session = await loadCurrentBrowserSession(database, installationId, token, now());
    if (!session || session.account.actor.id !== actorId) throw new AccountActionError('session');
    return session;
  }

  async function commit(target: AccountRecord, input: ChangeInput, values: Partial<Pick<AccountRecord, 'role' | 'disabledAt' | 'localAuth'>>) {
    const revision = nextAccountRevision(target.revision);
    const epoch = values.localAuth?.credentialsVersion ?? accountEpoch(target);
    const accountChange = { ...input, revision, epoch };
    const updated = await accounts(database).findOneAndUpdate({
      ...accountLookup(target.generationId, target.id), revision: target.revision,
      'localAuth.credentialsVersion': target.localAuth ? accountEpoch(target) : { $exists: false },
      accountChange: { $exists: false },
    }, { $set: { ...values, revision, accountChange } }, { ...durable, returnDocument: 'after' });
    if (!updated) throw new CommandRecoveryError('An account changed while recording its transition.');
    await checkpoint?.();
    await finishAccountChange(database, installationId, updated);
  }

  async function pendingApproval(id: string) {
    const generationId = await activeAccountGeneration(database, installationId);
    if (!generationId) throw new AccountActionError('approval');
    const time = now();
    const approval = await approvals(database).findOne({
      _id: workspaceKey(generationId, id), id, generationId, installationId, kind: 'account-approval', ...liveGrant(time),
    });
    if (!approval) throw new AccountActionError('approval');
    checkGrant(approval, approvalLifetimeMs);
    const actor = await accountById(database, generationId, approval.actorId);
    requireSiteAdmin(actor);
    const target = await accountById(database, generationId, approval.userId);
    if (!validEpoch(approval.actorEpoch) || accountEpoch(actor) !== approval.actorEpoch
        || target.revision !== approval.targetRevision || accountEpoch(target) !== approval.targetEpoch
        || !accountApprovalActionSchema.safeParse(approval.change).success) throw new AccountActionError('approval');
    await protectLastAdmin(database, target, approval.change);
    return { approval, target, time };
  }

  return {
    requestApproval(token: string, actorId: string, targetId: string, revision: number, change: AccountApprovalAction) {
      return gate.runCommand(async () => {
        const { stored: actor, generationId, time } = await current(token, actorId);
        requireSiteAdmin(actor);
        const target = await accountById(database, generationId, targetId);
        if (target.revision !== revision) throw new AccountActionError('revision');
        nextAccountRevision(revision);
        if ((change.action === 'role' && change.role === target.role)
            || (change.action === 'availability' && change.disabled === (target.disabledAt !== null))
            || (change.action === 'recovery' && target.disabledAt !== null)) throw new AccountActionError('forbidden');
        await protectLastAdmin(database, target, change);
        const id = newPublicId();
        const approval: Approval = {
          _id: workspaceKey(generationId, id), id, generationId, installationId, userId: targetId, actorId,
          kind: 'account-approval', targetRevision: revision, targetEpoch: accountEpoch(target), actorEpoch: accountEpoch(actor),
          change, tokenDigest: tokenDigest(newToken()), issuedAt: time,
          expiresAt: new Date(time.getTime() + approvalLifetimeMs), consumedAt: null, revokedAt: null,
        };
        await approvals(database).insertOne(approval, durable);
        return describeApproval(approval);
      });
    },
    inspectApproval(id: string) {
      return gate.readSnapshot(async () => describeApproval((await pendingApproval(id)).approval));
    },
    confirmApproval(id: string) {
      return gate.runCommand(async () => {
        const { approval, target, time } = await pendingApproval(id);
        const { change } = approval;
        const claim = { id, actorEpoch: approval.actorEpoch, targetEpoch: approval.targetEpoch, change };
        const identity = { id, approval: claim, actorId: approval.actorId, origin: 'operator', appliedAt: time } as const;
        const result = { outcome: 'applied', approval: describeApproval(approval) } as const;
        if (change.action === 'role') {
          await commit(target, { ...identity, kind: 'role' }, { role: change.role });
        } else if (change.action === 'availability') {
          await commit(target, { ...identity, kind: 'availability' }, {
            disabledAt: change.disabled ? time : null, localAuth: nextAuth(target),
          });
        } else {
          const grant = newToken();
          const recovery = { id: newPublicId(), digest: tokenDigest(grant), actorEpoch: approval.actorEpoch };
          await commit(target, { ...identity, kind: 'reset-issued', recovery }, { localAuth: nextAuth(target, null) });
          return accountApprovalResultSchema.parse({
            ...result, recovery: { grant, expiresAt: new Date(time.getTime() + recoveryLifetimeMs).toISOString() },
          });
        }
        return accountApprovalResultSchema.parse(result);
      });
    },
    changePassword(token: string, actorId: string, input: PasswordChange) {
      return gate.runCommand(async () => {
        const { stored, account, time } = await current(token, actorId);
        if (!await hasher.verify(input.currentPassword, account.auth.passwordVerifier)) throw new AccountActionError('password');
        const passwordVerifier = await hasher.encode(input.password);
        await commit(stored, { id: newPublicId(), actorId, kind: 'password-changed', origin: 'web', appliedAt: time },
          { localAuth: nextAuth(stored, passwordVerifier) });
      });
    },
    consumeRecovery(input: AccountRecoveryInput) {
      return gate.runCommand(async () => {
        const generationId = await activeAccountGeneration(database, installationId);
        if (!generationId) throw new AccountActionError('grant');
        const time = now();
        const grant = await recoveryGrants(database).findOne({
          installationId, generationId, kind: 'account-recovery', tokenDigest: tokenDigest(input.grant), ...liveGrant(time),
        });
        if (!grant) throw new AccountActionError('grant');
        checkGrant(grant, recoveryLifetimeMs);
        const target = await accounts(database).findOne(accountLookup(generationId, grant.userId));
        const issuer = await accounts(database).findOne(accountLookup(generationId, grant.actorId));
        if (!target || target.disabledAt !== null || accountEpoch(target) !== grant.targetEpoch
            || target.revision !== grant.targetRevision || !issuer
            || issuer.role !== 'admin' || (issuer.id !== target.id && !usableAdmin(issuer))
            || accountEpoch(issuer) !== (issuer.id === target.id ? grant.targetEpoch : grant.actorEpoch)) throw new AccountActionError('grant');
        const passwordVerifier = await hasher.encode(input.password);
        const appliedAt = now();
        if (appliedAt < time || appliedAt >= grant.expiresAt) throw new AccountActionError('grant');
        const localAuth = nextAuth(target, passwordVerifier);
        await commit(target, { id: grant.id, recoveryId: grant.id, actorId: target.id, kind: 'reset-consumed',
          origin: 'web', appliedAt }, { localAuth });
        return { status: localAuth.mfa !== 'none' ? 'enrollment-required' : 'confirmed' } as const;
      });
    },
  };
}

function nextAuth(account: AccountRecord, passwordVerifier = account.localAuth?.passwordVerifier ?? null) {
  const mfa = account.requiresMfaEnrollment ? 'enrollment-required' : account.localAuth?.mfa ?? 'none';
  const credentialsVersion = accountEpoch(account) + 1;
  if (!Number.isSafeInteger(credentialsVersion)) throw new AccountActionError('revision');
  return { ...account.localAuth, passwordVerifier, credentialsVersion, mfa };
}

export type AccountCredentials = ReturnType<typeof createAccountCredentials>;
