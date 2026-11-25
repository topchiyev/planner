import { AsyncLocalStorage } from 'node:async_hooks';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { errors } from 'oidc-provider';
import type { Db, Filter } from 'mongodb';
import { publicIdSchema } from '@planner/contracts/storage';
import { workspaceKey } from '../../storage/identity.js';
import { provisionOAuthCatalog, readInstallation, requireCurrentSchema } from '../../storage/schema.js';
import { accounts, getLocalAccount } from '../auth/accounts.js';
import { getFactor, hasPasswordOnlyAuth } from '../auth/mfa-account.js';
import { activeAccountGeneration, loadCurrentBrowserSession, loadCurrentBrowserSessionById } from '../auth/sessions.js';
import { CleanCommandRejection, type CommandGate } from '../command-gate/gate.js';
import { durable } from '../command-journal/records.js';
import { assertWorkspaceWritable } from '../migration/cutover.js';
import { oauthSigningKeys, type OAuthEnvelope, type OAuthSecrets } from './keys.js';

export const interactionLifetime = 300;
const freshAuthorizationMs = 5 * 60_000;
const connectionLifetimeMs = 30 * 24 * 60 * 60_000;
const maximumArtifactSeconds = 30 * 24 * 60 * 60;

type Scope = { db: Db; generationId: string };
interface Artifact {
  _id: string;
  generationId: string;
  id: string;
  kind: string;
  artifactId: string;
  userId?: string;
  clientId?: string;
  providerGrantId?: string;
  providerUid?: string;
  providerUserCode?: string;
  payload: OAuthEnvelope;
  expiresAt: Date;
  consumedAt: Date | null;
}
interface Connection {
  _id: string;
  generationId: string;
  id: string;
  userId: string;
  clientId: string;
  providerGrantId: string;
  browserSessionId: string;
  credentialsVersion: number;
  factorId: string | null;
  scope: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

function deterministicId(buffer: Buffer) {
  const bytes = Buffer.from(buffer.subarray(0, 16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class OAuthUnavailable extends CleanCommandRejection {
  constructor() { super('The Planner authorization service is unavailable.'); }
}

export function createOAuthStorage(
  installationId: string, gate: CommandGate, secrets: OAuthSecrets, now = () => new Date(),
) {
  const requests = new AsyncLocalStorage<Scope>();
  const artifacts = (db: Db) => db.collection<Artifact>('oauthArtifacts');
  const connections = (db: Db) => db.collection<Connection>('oauthConnections');
  let catalogReady = false;

  async function writableGeneration(db: Db) {
    const generationId = await activeAccountGeneration(db, installationId);
    if (!generationId) throw new OAuthUnavailable();
    await assertWorkspaceWritable(db, installationId, generationId);
    return generationId;
  }

  const grantKey = (generationId: string, grantId: string) => secrets.identity(generationId, 'grant', grantId);

  function artifactIdentity(generationId: string, kind: string, rawId: string) {
    const artifactId = secrets.identity(generationId, kind, 'artifact', rawId);
    const id = deterministicId(Buffer.from(artifactId, 'base64url'));
    return { generationId, kind, artifactId, id, _id: workspaceKey(generationId, id) };
  }

  async function run<T>(write: boolean, operation: (scope: Scope) => Promise<T>) {
    const scope = requests.getStore();
    if (!scope) throw new OAuthUnavailable();
    const execute = async () => {
      if (await writableGeneration(scope.db) !== scope.generationId) throw new OAuthUnavailable();
      return operation(scope);
    };
    return write ? gate.runCommand(execute) : gate.readSnapshot(execute);
  }

  function decode(row: Artifact) {
    if (row._id !== workspaceKey(row.generationId, row.id)) throw new OAuthUnavailable();
    const payload = secrets.artifacts.open(row.payload, [row.generationId, row.kind, row.artifactId]) as AdapterPayload;
    return { ...payload, ...(row.consumedAt && { consumed: Math.floor(row.consumedAt.getTime() / 1000) }) };
  }

  async function currentGrant({ db, generationId }: Scope, providerGrantId: string, time: Date) {
    const saved = await connections(db).findOne({ generationId, providerGrantId, revokedAt: { $type: 'null' }, expiresAt: { $gt: time } });
    if (!saved || !publicIdSchema.safeParse(saved.id).success || saved._id !== workspaceKey(generationId, saved.id)
        || !publicIdSchema.safeParse(saved.userId).success) return null;
    const stored = await accounts(db).findOne({ _id: workspaceKey(generationId, saved.userId), generationId, id: saved.userId });
    const account = getLocalAccount(stored);
    if (!stored || !account || account.auth.credentialsVersion !== saved.credentialsVersion) return null;
    const factorMatches = saved.factorId === null ? hasPasswordOnlyAuth(stored)
      : publicIdSchema.safeParse(saved.factorId).success && getFactor(stored)?.id === saved.factorId;
    return factorMatches ? saved : null;
  }

  async function currentArtifactGrant(scope: Scope, kind: string, providerGrantId: string, time: Date) {
    const grant = await currentGrant(scope, providerGrantId, time);
    if (!grant || kind !== 'AuthorizationCode') return grant;
    // A code still belongs to the exact session that consented. Issued access belongs to the connection.
    const { db, generationId } = scope;
    const session = await loadCurrentBrowserSessionById(db, installationId, generationId, grant.browserSessionId, time);
    return session && session.account.actor.id === grant.userId ? grant : null;
  }

  function adapter(kind: string): Adapter {
    const digest = (generationId: string, field: string, id: string) => secrets.identity(generationId, kind, field, id);
    function find(query: (generationId: string) => Filter<Artifact>) {
      return run(false, async ({ db, generationId }) => {
        const time = now();
        const row = await artifacts(db).findOne({ generationId, kind, expiresAt: { $gt: time }, ...query(generationId) });
        if (!row) return undefined;
        if (row.providerGrantId && !await currentArtifactGrant({ db, generationId }, kind, row.providerGrantId, time)) return undefined;
        return decode(row);
      });
    }
    return {
      async upsert(rawId, payload, expiresIn) {
        await run(true, async ({ db, generationId }) => {
          const time = now();
          const expiry = expiresIn ?? maximumArtifactSeconds;
          if (!Number.isSafeInteger(expiry) || expiry < 1 || expiry > maximumArtifactSeconds) throw new OAuthUnavailable();
          const { _id, ...identity } = artifactIdentity(generationId, kind, rawId);
          const rawGrant = kind === 'Grant' ? rawId : payload.grantId;
          const providerGrantId = rawGrant ? grantKey(generationId, rawGrant) : undefined;
          if (providerGrantId && !await currentArtifactGrant({ db, generationId }, kind, providerGrantId, time)) throw new OAuthUnavailable();
          const { consumed: _consumed, ...unconsumed } = payload;
          const fields = {
            ...identity, ...(payload.accountId && { userId: payload.accountId }),
            ...(payload.clientId && { clientId: payload.clientId }),
            ...(providerGrantId && { providerGrantId }),
            ...(payload.uid && { providerUid: digest(generationId, 'uid', payload.uid) }),
            ...(payload.userCode && { providerUserCode: digest(generationId, 'user-code', payload.userCode) }),
            payload: secrets.artifacts.seal(unconsumed, [generationId, kind, identity.artifactId]),
            expiresAt: new Date(time.getTime() + expiry * 1000),
          };
          await artifacts(db).updateOne({ _id, ...identity }, { $set: fields, $setOnInsert: { consumedAt: null } },
            { ...durable, upsert: true });
        });
      },
      find: (id) => find((generationId) => artifactIdentity(generationId, kind, id)),
      findByUserCode: (code) => find((generationId) => ({ providerUserCode: digest(generationId, 'user-code', code) })),
      findByUid: (uid) => find((generationId) => ({ providerUid: digest(generationId, 'uid', uid) })),
      async consume(rawId) {
        const consumed = await run(true, async ({ db, generationId }) => {
          const time = now();
          const identity = artifactIdentity(generationId, kind, rawId);
          const row = await artifacts(db).findOne({ ...identity, expiresAt: { $gt: time }, consumedAt: { $type: 'null' } });
          if (!row || (row.providerGrantId && !await currentArtifactGrant({ db, generationId }, kind, row.providerGrantId, time))) return false;
          const saved = await artifacts(db).updateOne({ ...identity, expiresAt: { $gt: time }, consumedAt: { $type: 'null' } },
            { $set: { consumedAt: time } }, durable);
          return saved.modifiedCount === 1;
        });
        if (!consumed) throw new errors.InvalidGrant('The authorization artifact expired or was already consumed.');
      },
      async destroy(rawId) {
        await run(true, async ({ db, generationId }) => {
          if (kind === 'Grant') {
            await connections(db).updateOne({ generationId, providerGrantId: grantKey(generationId, rawId), revokedAt: { $type: 'null' } },
              { $set: { revokedAt: now() } }, durable);
          }
          await artifacts(db).deleteOne(artifactIdentity(generationId, kind, rawId), durable);
        });
      },
      async revokeByGrantId(rawId) {
        await run(true, async ({ db, generationId }) => {
          const providerGrantId = grantKey(generationId, rawId);
          await connections(db).updateOne({ generationId, providerGrantId, revokedAt: { $type: 'null' } },
            { $set: { revokedAt: now() } }, durable);
          await artifacts(db).deleteMany({ generationId, kind, providerGrantId }, durable);
        });
      },
    };
  }

  async function freshBrowserSession(db: Db, generationId: string, browserToken: string) {
    const time = now();
    const session = await loadCurrentBrowserSession(db, installationId, browserToken, time);
    if (!session || session.generationId !== generationId) return null;
    if (session.account.auth.mfa !== 'none'
      && (!session.factorVerifiedAt || time.getTime() - session.factorVerifiedAt.getTime() >= freshAuthorizationMs)) return null;
    return session;
  }

  return {
    adapter,
    async withRequest<T>(db: Db, operation: () => Promise<T>) {
      const generationId = await gate.readSnapshot(() => writableGeneration(db));
      return requests.run({ db, generationId }, operation);
    },
    keys: (db: Db) => gate.runCommand(async () => {
      const installation = await readInstallation(db, installationId);
      requireCurrentSchema(installation);
      await writableGeneration(db);
      if (!catalogReady) {
        await provisionOAuthCatalog(db);
        catalogReady = true;
      }
      return oauthSigningKeys(db, installation, secrets);
    }),
    accountExists: (id: string) => run(false, async ({ db, generationId }) =>
      publicIdSchema.safeParse(id).success && !!getLocalAccount(await accounts(db).findOne({ _id: workspaceKey(generationId, id), generationId, id }))),
    browserSession: (token: string) => run(false, ({ db, generationId }) => freshBrowserSession(db, generationId, token)),
    acceptConsent(input: { interactionId: string; token: string; sessionId: string; grantId?: string; clientId: string; scope: string }) {
      return run(true, async ({ db, generationId }) => {
        const session = await freshBrowserSession(db, generationId, input.token);
        if (!session || session.sessionId !== input.sessionId) return null;
        const time = now();
        const { _id, ...identity } = artifactIdentity(generationId, 'PlannerConsent', input.interactionId);
        const binding = [generationId, identity.kind, identity.artifactId];
        const claimed = await artifacts(db).updateOne({ _id, ...identity }, { $setOnInsert: {
          payload: secrets.artifacts.seal({}, binding), userId: session.account.actor.id, clientId: input.clientId,
          consumedAt: time, expiresAt: new Date(time.getTime() + interactionLifetime * 1000),
        } }, { ...durable, upsert: true });
        if (claimed.upsertedCount !== 1) return null;
        if (input.grantId) {
          const providerGrantId = grantKey(generationId, input.grantId);
          const id = deterministicId(Buffer.from(providerGrantId, 'base64url'));
          await connections(db).insertOne({ _id: workspaceKey(generationId, id), generationId, id, userId: session.account.actor.id,
            clientId: input.clientId, providerGrantId, browserSessionId: session.sessionId,
            credentialsVersion: session.account.auth.credentialsVersion, factorId: session.factorId ?? null, scope: input.scope,
            issuedAt: time, expiresAt: new Date(time.getTime() + connectionLifetimeMs), revokedAt: null,
          }, durable);
        }
        return session.account.actor.id;
      });
    },
    async accessToken(token: string) {
      if (!/^[A-Za-z0-9_-]{20,300}$/u.test(token)) return null;
      return run(false, async ({ db, generationId }) => {
        const identity = artifactIdentity(generationId, 'AccessToken', token);
        const time = now();
        const row = await artifacts(db).findOne({ ...identity, expiresAt: { $gt: time }, consumedAt: { $type: 'null' } });
        if (!row?.providerGrantId || !publicIdSchema.safeParse(row.userId).success) return null;
        const grant = await currentGrant({ db, generationId }, row.providerGrantId, time);
        const payload = decode(row);
        if (!grant || grant.userId !== row.userId || grant.clientId !== row.clientId || typeof payload.scope !== 'string'
            || payload.accountId !== grant.userId || payload.clientId !== grant.clientId
            || !payload.scope.split(' ').every((scope) => grant.scope.split(' ').includes(scope))) return null;
        return { generationId, userId: grant.userId, clientId: grant.clientId,
          audience: payload.aud, scope: payload.scope, grantId: grant.id };
      });
    },
  };
}

export type OAuthStorage = ReturnType<typeof createOAuthStorage>;
