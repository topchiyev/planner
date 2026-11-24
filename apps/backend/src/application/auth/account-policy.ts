import { accountProfileSchema, adminAccountSchema, type AccountApprovalAction } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { CleanCommandRejection } from '../command-gate/gate.js';
import { accounts, getLocalAccount, type AccountRecord } from './accounts.js';
import { normalizeIdentifier } from './credentials.js';

export const accountErrors = {
  session: [401, 'UNAUTHENTICATED', 'Sign in to continue.'],
  forbidden: [403, 'FORBIDDEN', 'This account action is not allowed.'],
  missing: [404, 'ACCOUNT_NOT_FOUND', 'The account is unavailable.'],
  identity: [409, 'IDENTIFIER_IN_USE', 'That email or username is already in use.'],
  revision: [409, 'REVISION_CONFLICT', 'This account changed. Reload and try again.'],
  lastAdmin: [409, 'LAST_USABLE_ADMIN', 'Keep at least one administrator who can sign in.'],
  approval: [409, 'APPROVAL_UNAVAILABLE', 'The local approval expired or the account changed.'],
  password: [403, 'REAUTHENTICATION_REQUIRED', 'Enter your current password to continue.'],
  grant: [400, 'INVALID_GRANT', 'The recovery grant is invalid or has expired.'],
} as const;

export class AccountActionError extends CleanCommandRejection {
  constructor(readonly kind: keyof typeof accountErrors) { super(accountErrors[kind][2]); }
}

export function accountLookup(generationId: string, id: string) {
  return { _id: workspaceKey(generationId, id), generationId, id };
}

export async function accountById(database: Db, generationId: string, id: string) {
  const account = await accounts(database).findOne(accountLookup(generationId, id));
  if (!account) throw new AccountActionError('missing');
  return account;
}

export function accountIdentity(email: string, username: string | null) {
  return { email, username, normalizedEmail: normalizeIdentifier(email),
    normalizedUsername: username === null ? null : normalizeIdentifier(username) };
}

export async function checkAccountIdentity(
  database: Db, generationId: string, identity: ReturnType<typeof accountIdentity>, omitId?: string,
) {
  const keys = [identity.normalizedEmail, identity.normalizedUsername].filter((value): value is string => value !== null);
  const conflict = await accounts(database).findOne({
    generationId, ...(omitId && { id: { $ne: omitId } }),
    $or: [{ normalizedEmail: { $in: keys } }, { normalizedUsername: { $in: keys } }],
  }, { projection: { _id: 1 } });
  if (conflict) throw new AccountActionError('identity');
}

export function profileOf(account: AccountRecord) {
  const { id, revision, name, email, username, phone, organization, language } = account;
  return accountProfileSchema.parse({ id, revision, name, email, username: username ?? null,
    phone: phone ?? null, organization: organization ?? null, language: language ?? null });
}

export function adminAccountOf(account: AccountRecord) {
  const { id, revision, name, email, username, role } = account;
  const disabled = account.disabledAt !== null;
  const local = getLocalAccount(account);
  let signIn: 'disabled' | 'enrollment-required' | 'available' | 'password-required' = 'password-required';
  if (disabled) signIn = 'disabled';
  else if (account.requiresMfaEnrollment || local?.auth.mfa === 'enrollment-required') signIn = 'enrollment-required';
  else if (local?.auth.mfa === 'none') signIn = 'available';
  return adminAccountSchema.parse({ id, revision, name, email, username: username ?? null, role, disabled, signIn });
}

export function accountEpoch(account: AccountRecord) {
  const epoch = account.localAuth?.credentialsVersion ?? 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new AccountActionError('approval');
  }
  return epoch;
}

export function nextAccountRevision(revision: number) {
  const next = revisionSchema.safeParse(revision + 1);
  if (!next.success) throw new AccountActionError('revision');
  return next.data;
}

export function usableAdmin(account: AccountRecord) {
  return account.role === 'admin' && !account.requiresMfaEnrollment && getLocalAccount(account)?.auth.mfa === 'none';
}

export async function protectLastAdmin(database: Db, account: AccountRecord, change: AccountApprovalAction) {
  const removesAccess = change.action === 'recovery' || (change.action === 'availability' && change.disabled)
    || (change.action === 'role' && change.role !== 'admin');
  if (!removesAccess || !usableAdmin(account)) return;
  const alternatives = accounts(database).find({
    generationId: account.generationId, id: { $ne: account.id }, role: 'admin', disabledAt: { $type: 'null' },
  });
  for await (const other of alternatives) {
    if (usableAdmin(other) && other._id === workspaceKey(other.generationId, other.id)) return;
  }
  throw new AccountActionError('lastAdmin');
}

export function requireSiteAdmin(account: AccountRecord) {
  if (!usableAdmin(account)) throw new AccountActionError('forbidden');
}
