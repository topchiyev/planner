import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BrowserSession, LoginInput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import type { CommandGate } from '../command-gate/gate.js';
import { assertChanged, durable } from '../command-journal/records.js';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema } from '../../storage/schema.js';
import { accounts, getLocalAccount } from './accounts.js';
import { csrfToken, newToken, normalizeIdentifier, tokenDigest } from './credentials.js';
import type { PasswordHasher } from './password.js';

const absoluteSessionMs = 30 * 24 * 60 * 60_000;

interface SessionRecord {
  _id: string;
  id: string;
  installationId: string;
  generationId: string;
  userId: string;
  tokenDigest: string;
  credentialsVersion: number;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

type LoginResult = { status: 'invalid' | 'enrollment-required' } | { status: 'authenticated'; token: string; session: BrowserSession };

export async function activeAccountGeneration(database: Db, installationId: string) {
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  return installation.setup?.pendingAction === 'complete' ? installation.activeGenerationId : null;
}

// The caller holds a read or command lease through verification and use.
export async function loadCurrentBrowserSession(database: Db, installationId: string, token: string, time: Date) {
  const generationId = await activeAccountGeneration(database, installationId);
  if (!generationId) return null;
  const digest = tokenDigest(token);
  const record = await database.collection<SessionRecord>('sessions').findOne({ installationId, generationId, tokenDigest: digest, revokedAt: { $type: 'null' } });
  if (!record || !publicIdSchema.safeParse(record.id).success || record._id !== workspaceKey(generationId, record.id)
      || !publicIdSchema.safeParse(record.userId).success || !isStoredDate(record.createdAt)
      || !isStoredDate(record.lastActivityAt) || !isStoredDate(record.expiresAt)
      || record.createdAt > record.lastActivityAt || record.lastActivityAt > time
      || record.expiresAt.getTime() !== record.createdAt.getTime() + absoluteSessionMs || time >= record.expiresAt) return null;
  const stored = await accounts(database).findOne({
    _id: workspaceKey(generationId, record.userId), generationId, id: record.userId,
  });
  const account = getLocalAccount(stored);
  if (!stored || !account || account.auth.mfa !== 'none' || account.auth.credentialsVersion !== record.credentialsVersion
      || time.getTime() - record.lastActivityAt.getTime() >= account.inactivityMs) return null;
  const match = {
    _id: record._id, installationId, generationId, tokenDigest: digest, revokedAt: { $type: 'null' as const },
  };
  return { account, stored, generationId, time, match };
}

export function createBrowserSessions(
  database: Db,
  installationId: string,
  gate: CommandGate,
  hasher: PasswordHasher,
  now = () => new Date(),
) {
  const sessions = database.collection<SessionRecord>('sessions');
  const activeGeneration = () => activeAccountGeneration(database, installationId);
  const loadCurrent = (token: string) => loadCurrentBrowserSession(database, installationId, token, now());

  return {
    async login(input: LoginInput): Promise<LoginResult> {
      const identifier = normalizeIdentifier(input.identifier);
      const candidate = await gate.readSnapshot(async () => {
        const generationId = await activeGeneration();
        if (!generationId || !identifier) return null;
        const matches = await accounts(database).find({
          generationId, $or: [{ normalizedEmail: identifier }, { normalizedUsername: identifier }],
        }, { limit: 2 }).toArray();
        if (matches.length !== 1) return null;
        const [record] = matches;
        const account = getLocalAccount(record);
        if (!account || record._id !== workspaceKey(generationId, account.actor.id)) return null;
        return { generationId, account };
      });

      const validPassword = await hasher.verify(input.password, candidate?.account.auth.passwordVerifier);
      if (!validPassword || !candidate) return { status: 'invalid' };
      return gate.runCommand(async () => {
        const generationId = await activeGeneration();
        if (generationId !== candidate.generationId) return { status: 'invalid' };
        const actorId = candidate.account.actor.id;
        const record = await accounts(database).findOne({ _id: workspaceKey(generationId, actorId), id: actorId, generationId });
        const account = getLocalAccount(record);
        if (!account || !isDeepStrictEqual(account.auth, candidate.account.auth)
            || (record?.normalizedEmail !== identifier && record?.normalizedUsername !== identifier)) return { status: 'invalid' };
        if (account.auth.mfa === 'enrollment-required') return { status: 'enrollment-required' };
        if (account.auth.mfa !== 'none') return { status: 'invalid' };
        const token = newToken();
        const id = randomUUID();
        const time = now();
        await sessions.insertOne({
          _id: workspaceKey(generationId, id), id, generationId, installationId, userId: actorId,
          tokenDigest: tokenDigest(token), credentialsVersion: account.auth.credentialsVersion, createdAt: time,
          lastActivityAt: time, expiresAt: new Date(time.getTime() + absoluteSessionMs), revokedAt: null,
        }, durable);
        return { status: 'authenticated', token, session: {
          status: 'authenticated', account: account.actor, csrfToken: csrfToken(token),
        } };
      });
    },

    read(token: string) {
      return gate.runCommand(async (): Promise<BrowserSession | null> => {
        const current = await loadCurrent(token);
        if (!current) return null;
        const touched = await sessions.updateOne(current.match, { $max: { lastActivityAt: current.time } }, durable);
        assertChanged(touched.matchedCount);
        return { status: 'authenticated', account: current.account.actor, csrfToken: csrfToken(token) };
      });
    },

    revoke(token: string) {
      return gate.runCommand(async () => {
        const current = await loadCurrent(token);
        if (!current) return false;
        const revoked = await sessions.updateOne(current.match, { $set: { revokedAt: current.time } }, durable);
        assertChanged(revoked.matchedCount);
        return true;
      });
    },
  };
}

export type BrowserSessions = ReturnType<typeof createBrowserSessions>;
