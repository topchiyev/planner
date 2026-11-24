import {
  accountDirectorySchema, accountPreferencesSchema, type AccountDirectoryQuery, type AccountProvision,
  type PreferencesUpdate, type ProfileUpdate,
} from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { newPublicId } from '../../storage/identity.js';
import type { CommandGate } from '../command-gate/gate.js';
import { InvalidPageCursor, pageCursors } from '../pagination/cursor.js';
import { CommandJournal } from '../command-journal/journal.js';
import type { JournalOperation, JournalValue } from '../command-journal/operation.js';
import {
  accountIdentity, AccountActionError, adminAccountOf, checkAccountIdentity, profileOf, requireSiteAdmin,
} from './account-policy.js';
import { accounts, defaultPreferences } from './accounts.js';
import { normalizeIdentifier } from './credentials.js';
import type { PasswordHasher } from './password.js';
import { loadCurrentBrowserSession } from './sessions.js';

export function createAccountDirectory(
  database: Db, installationId: string, gate: CommandGate, hasher: PasswordHasher, now = () => new Date(),
) {
  async function current(token: string, actorId: string, generationId?: string) {
    const session = await loadCurrentBrowserSession(database, installationId, token, now());
    if (!session || session.account.actor.id !== actorId || (generationId && session.generationId !== generationId)) {
      throw new AccountActionError('session');
    }
    return session;
  }

  function run(actorId: string, key: string, operationId: string, operation: JournalOperation) {
    const journal = new CommandJournal(gate, database, installationId, { operations: { [operationId]: operation } });
    return journal.execute({ actorId, operationId, idempotencyKey: key, input: null });
  }

  return {
    profile(token: string, actorId: string) {
      return gate.readSnapshot(async () => profileOf((await current(token, actorId)).stored));
    },
    preferences(token: string, actorId: string) {
      return gate.readSnapshot(async () => {
        const { stored } = await current(token, actorId);
        return accountPreferencesSchema.parse({ revision: stored.revision, preferences: { ...defaultPreferences, ...stored.preferences } });
      });
    },
    list(token: string, actorId: string, query: AccountDirectoryQuery) {
      return gate.readSnapshot(async () => {
        const { stored, generationId } = await current(token, actorId);
        const admin = stored.role === 'admin';
        if (!admin && stored.role !== 'projectOwner') throw new AccountActionError('forbidden');
        const lookup = normalizeIdentifier(query.q ?? '');
        const prefix = lookup.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const limit = query.limit ?? 25;
        const cursorScope = { actorId, generationId, operation: 'account.directory', query: [stored.role, lookup, String(limit)],
          order: 'id-ascending' };
        const position = query.cursor ? publicIdSchema.safeParse(pageCursors.decode(cursorScope, query.cursor)) : undefined;
        if (position && !position.success) throw new InvalidPageCursor('The account page position is invalid.');
        const rows = await accounts(database).find({
          generationId, ...(!admin && { disabledAt: { $type: 'null' as const } }),
          ...(position && { id: { $gt: position.data } }),
          ...(prefix && (admin ? { $or: [
            { name: { $regex: '^' + prefix, $options: 'i' } },
            { normalizedEmail: { $regex: '^' + prefix } },
            { normalizedUsername: { $regex: '^' + prefix } },
          ] } : { name: { $regex: '^' + prefix, $options: 'i' } })),
        }, { sort: { id: 1 }, limit: limit + 1, ...(!admin && { projection: { _id: 0, id: 1, name: 1, role: 1 } }) }).toArray();
        const page = rows.slice(0, limit);
        return accountDirectorySchema.parse({
          access: admin ? 'administration' : 'directory',
          accounts: admin ? page.map(adminAccountOf) : page.map(({ id, name, role }) => ({ id, name, role })),
          next: rows.length > limit ? pageCursors.encode(cursorScope, page[limit - 1].id) : null,
        });
      });
    },
    updateProfile(token: string, actorId: string, key: string, input: ProfileUpdate) {
      const { revision, currentPassword, ...changes } = input;
      return run(actorId, key, 'account.profile', {
        normalize: () => ({ revision, ...changes }),
        async authorize({ generationId }) {
          const { account } = await current(token, actorId, generationId);
          if (('email' in changes || 'username' in changes)
              && (!currentPassword || !await hasher.verify(currentPassword, account.auth.passwordVerifier))) {
            throw new AccountActionError('password');
          }
        },
        async plan({ generationId }) {
          const { stored } = await current(token, actorId, generationId);
          if (revision !== stored.revision) throw new AccountActionError('revision');
          const identity = accountIdentity(changes.email ?? stored.email,
            changes.username === undefined ? stored.username ?? null : changes.username);
          await checkAccountIdentity(database, generationId, identity, actorId);
          return {
            effects: [{ kind: 'update', collection: 'users', id: actorId, revision, fields: { ...changes, ...identity } }],
            result: profileOf({ ...stored, ...changes, ...identity, revision: revision + 1 }),
            audit: { resourceId: actorId, resourceType: 'account', origin: 'web', action: 'account.profile' },
          };
        },
      });
    },
    updatePreferences(token: string, actorId: string, key: string, input: PreferencesUpdate) {
      return run(actorId, key, 'account.preferences', {
        normalize: () => input,
        authorize: async ({ generationId }) => { await current(token, actorId, generationId); },
        async plan({ generationId }) {
          const { stored } = await current(token, actorId, generationId);
          if (input.revision !== stored.revision) throw new AccountActionError('revision');
          const preferences = { ...defaultPreferences, ...stored.preferences, ...input.preferences };
          return {
            effects: [{ kind: 'update', collection: 'users', id: actorId, revision: input.revision, fields: { preferences } }],
            result: { revision: input.revision + 1, preferences },
            audit: { resourceId: actorId, resourceType: 'account', origin: 'web', action: 'account.preferences' },
          };
        },
      });
    },
    provision(token: string, actorId: string, key: string, input: AccountProvision) {
      return run(actorId, key, 'account.provision', {
        normalize: () => input,
        authorize: async ({ generationId }) => { requireSiteAdmin((await current(token, actorId, generationId)).stored); },
        async plan({ generationId, timestamp }) {
          const identity = accountIdentity(input.email, input.username);
          await checkAccountIdentity(database, generationId, identity);
          const id = newPublicId();
          const fields = { ...identity, name: input.name, role: input.role, disabledAt: null, createdAt: timestamp,
            preferences: defaultPreferences };
          return {
            effects: [{ kind: 'insert', collection: 'users', id, fields }],
            result: { id, name: input.name, role: input.role, email: input.email, username: input.username,
              revision: 1, disabled: false, signIn: 'password-required' } satisfies JournalValue,
            audit: { resourceId: id, resourceType: 'account', origin: 'web', action: 'account.provision' },
          };
        },
      });
    },
  };
}

export type AccountDirectory = ReturnType<typeof createAccountDirectory>;
