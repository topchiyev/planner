import { randomUUID, type KeyObject } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BrowserSession, LoginInput, VerifyMfaInput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import type { CommandGate } from '../command-gate/gate.js';
import { assertChanged, durable } from '../command-journal/records.js';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema } from '../../storage/schema.js';
import { accounts, getLocalAccount } from './accounts.js';
import { csrfToken, newToken, normalizeIdentifier, tokenDigest } from './credentials.js';
import { getFactor, hasPasswordOnlyAuth, hasPendingFactorEnrollment } from './mfa-account.js';
import { beginPasswordMfa, verifyPasswordMfa } from './mfa-login.js';
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
  factorId?: string;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

type LoginResult =
  | { status: 'invalid' }
  | { status: 'enrollment-required'; enrollmentId?: string }
  | { status: 'challenge-required'; challengeId: string }
  | { status: 'authenticated'; token: string; session: BrowserSession };

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
  if (!stored || !account || account.auth.credentialsVersion !== record.credentialsVersion) return null;
  const deadline = Math.min(record.expiresAt.getTime(), record.lastActivityAt.getTime() + account.inactivityMs);
  if (time.getTime() >= deadline) return null;
  if (account.auth.mfa === 'none') {
    if (!hasPasswordOnlyAuth(stored) || record.factorId !== undefined) return null;
  } else {
    const factor = getFactor(stored);
    if (!factor || record.factorId !== factor.id) return null;
  }
  const match = {
    _id: record._id, installationId, generationId, tokenDigest: digest, revokedAt: { $type: 'null' as const },
  };
  return { account, stored, generationId, time, deadline, match };
}

export function createBrowserSessions(
  database: Db,
  installationId: string,
  gate: CommandGate,
  hasher: PasswordHasher,
  now = () => new Date(), mfaKey?: KeyObject,
) {
  const sessions = database.collection<SessionRecord>('sessions');
  const activeGeneration = () => activeAccountGeneration(database, installationId);
  const loadCurrent = (token: string) => loadCurrentBrowserSession(database, installationId, token, now());

  async function createSession(
    generationId: string, account: NonNullable<ReturnType<typeof getLocalAccount>>, time: Date, factorId?: string,
  ) {
    const token = newToken();
    const id = randomUUID();
    await sessions.insertOne({
      _id: workspaceKey(generationId, id), id, generationId, installationId, userId: account.actor.id,
      tokenDigest: tokenDigest(token), credentialsVersion: account.auth.credentialsVersion, createdAt: time,
      ...(factorId && { factorId }),
      lastActivityAt: time, expiresAt: new Date(time.getTime() + absoluteSessionMs), revokedAt: null,
    }, durable);
    const session: BrowserSession = { status: 'authenticated', account: account.actor, csrfToken: csrfToken(token) };
    return { status: 'authenticated', token, session } as const;
  }

  return {
    async login(input: LoginInput, trustedToken?: string): Promise<LoginResult> {
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
        if (!record || !account || account.auth.credentialsVersion !== candidate.account.auth.credentialsVersion
            || account.auth.mfa !== candidate.account.auth.mfa
            || !isDeepStrictEqual(account.auth.passwordVerifier, candidate.account.auth.passwordVerifier)
            || (record.normalizedEmail !== identifier && record.normalizedUsername !== identifier)) return { status: 'invalid' };
        const time = now();
        if (!mfaKey) {
          if (account.auth.mfa === 'enrollment-required' && hasPendingFactorEnrollment(record)) return { status: 'enrollment-required' };
          return hasPasswordOnlyAuth(record) ? createSession(generationId, account, time) : { status: 'invalid' };
        }
        const step = await beginPasswordMfa(database, installationId, record, time, trustedToken);
        if (step.status !== 'passed') return step;
        return createSession(generationId, account, time, step.factorId);
      });
    },

    verifyMfa(input: VerifyMfaInput, allowActorAttempt?: (userId: string) => boolean) {
      return gate.runCommand(async () => {
        if (!mfaKey) return null;
        const generationId = await activeGeneration();
        if (!generationId) return null;
        const time = now();
        const verified = await verifyPasswordMfa(database, installationId, generationId, mfaKey, input, time, allowActorAttempt);
        if (!verified) return null;
        const { session, token } = await createSession(generationId, verified.account, time, verified.factorId);
        return { session, token, ...(verified.trustedToken && { trustedToken: verified.trustedToken }) };
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
