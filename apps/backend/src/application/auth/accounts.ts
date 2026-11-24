import { accountNameSchema, inactivitySchema, siteRoleSchema, type AccountPreferences, type SessionActor } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import type { AccountChange } from './account-credentials.js';
import { isPasswordVerifier, type PasswordVerifier } from './password.js';

export const inactivityMs = {
  never: Infinity, '2m': 120_000, '5m': 300_000, '10m': 600_000, '30m': 1_800_000, '12h': 43_200_000,
} as const;

export interface AccountRecord {
  _id: string;
  id: string;
  generationId: string;
  revision: number;
  name: string;
  email: string;
  normalizedEmail: string;
  username: string | null;
  normalizedUsername: string | null;
  phone?: string | null;
  organization?: string | null;
  language?: string | null;
  requiresMfaEnrollment?: boolean;
  role: SessionActor['role'];
  disabledAt: Date | null;
  createdAt: Date;
  preferences: AccountPreferences;
  accountChange?: AccountChange;
  localAuth?: {
    passwordVerifier: PasswordVerifier | null;
    credentialsVersion: number;
    mfa: 'none' | 'enrollment-required' | 'totp';
  };
}

export const defaultPreferences: AccountRecord['preferences'] = {
  autoLogout: '12h',
  editorMode: 'wysiwyg',
  homeView: 'groupedProjects',
  projectOrder: 'byDefault',
  followOwnCards: false,
  followOnComment: true,
  showFavorites: true,
  highlightRecentlyChanged: true,
};
export const accounts = (database: Db) => database.collection<AccountRecord>('users');

export function getLocalAccount(account: AccountRecord | null) {
  if (!account || account.disabledAt !== null || !publicIdSchema.safeParse(account.id).success) return null;
  const { localAuth: auth } = account;
  const role = siteRoleSchema.safeParse(account.role);
  const name = accountNameSchema.safeParse(account.name);
  const inactivity = inactivitySchema.safeParse(account.preferences?.autoLogout ?? defaultPreferences.autoLogout);
  if (!auth || !isPasswordVerifier(auth.passwordVerifier) || !Number.isSafeInteger(auth.credentialsVersion)
      || auth.credentialsVersion < 1 || !role.success || !name.success || !inactivity.success) return null;
  return {
    actor: { id: account.id, name: name.data, role: role.data },
    auth: { ...auth, passwordVerifier: auth.passwordVerifier,
      mfa: account.requiresMfaEnrollment ? 'enrollment-required' as const : auth.mfa },
    inactivityMs: inactivityMs[inactivity.data],
  };
}
