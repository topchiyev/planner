import { randomUUID, timingSafeEqual, type KeyObject } from 'node:crypto';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import { isOAuthInteractionPath, workspaceSignInPath } from '@planner/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import type Provider from 'oidc-provider';
import { errors } from 'oidc-provider';
import { readSessionCookie } from '../application/auth/credentials.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import { oauthSecrets } from '../application/oauth/keys.js';
import { createOAuthStorage } from '../application/oauth/storage.js';
import {
  authorizationPath, createPlannerProvider, interactionPath, issuerMetadataPath, keysPath, oauthMetadata,
  protectedResourceMetadataPath, readScope, requestedPlannerScopes, tokenPath, writeScope, type PlannerOAuthClient,
} from '../application/oauth/provider.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    plannerOAuth?: true;
  }
}

export function createNativeOAuth(config: NativeInstallationConfig, gate: CommandGate, key: KeyObject) {
  return createNativeOAuthRuntime(config.publicUrl, config.installationId, gate, key, async (operation) => {
    const client = await connectConfiguredNativeMongo(config);
    try { return await operation(client.db(databaseName)); }
    finally { await client.close(); }
  });
}

export function createNativeOAuthRuntime(
  origin: string, installationId: string, gate: CommandGate, key: KeyObject,
  withDatabase: <T>(run: (db: Db) => Promise<T>) => Promise<T>, clients: readonly PlannerOAuthClient[] = [],
) {
  const secrets = oauthSecrets(key, installationId);
  const storage = createOAuthStorage(installationId, gate, secrets);
  let provider: ReturnType<typeof loadProvider> | undefined;
  async function loadProvider(db: Db) {
    const instance = createPlannerProvider(origin, storage, secrets.cookies, await storage.keys(db), clients);
    return { instance, callback: instance.callback() };
  }
  return {
    origin, clients, storage, secrets,
    request: <T>(operation: () => Promise<T>) => withDatabase((db) => storage.withRequest(db, operation)),
    withProvider: <T>(operation: (value: Awaited<ReturnType<typeof loadProvider>>) => Promise<T>) => withDatabase(async (db) => {
      const pending = provider ??= loadProvider(db);
      const loaded = await pending.catch((error: unknown) => {
        if (provider === pending) provider = undefined;
        throw error;
      });
      return storage.withRequest(db, () => operation(loaded));
    }),
  };
}

export type NativeOAuthRuntime = ReturnType<typeof createNativeOAuthRuntime>;

const config = { plannerOAuth: true } as const;
const unavailable = { error: 'temporarily_unavailable' } as const;
const invalid = { error: 'invalid_request' } as const;
type Input = { csrf: string; decision: 'allow' | 'cancel'; write: boolean };

function trustCanonicalRequest(request: FastifyRequest) {
  // Native HTTP handling has already stripped client-controlled forwarding and Planner headers.
  request.raw.headers['x-forwarded-proto'] = 'https';
}

function canProxy(request: FastifyRequest, reply: FastifyReply) {
  if (request.plannerConnection?.clientAddress) return true;
  reply.code(403).header('Cache-Control', 'no-store').send({ error: 'access_denied' });
  return false;
}

function readAuthorizationRequest(request: FastifyRequest, resource: string) {
  const query = new URL(request.url, resource).searchParams;
  return query.getAll('resource').length === 1 && query.get('resource') === resource
    && query.getAll('scope').length === 1 && !!requestedPlannerScopes(query.get('scope'))
    && query.getAll('redirect_uri').length === 1;
}

function consentForm(csrf: string, account: string, client: string, redirect: URL, write: boolean) {
  const escape = (text: string) => text.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect to Planner</title><main>
<h1>Connect to Planner</h1><p>Signed in as ${escape(account)}.</p>
<p>${escape(client)} is requesting access to read your Planner workspace. Planner will return you to ${escape(redirect.host)}.</p>
<form method="post"><input type="hidden" name="csrf" value="${escape(csrf)}">
${write ? '<label><input type="checkbox" name="write" value="yes"> Allow changes you have permission to make</label>' : ''}
<button name="decision" value="allow">Allow</button><button name="decision" value="cancel">Cancel</button>
</form></main></html>`;
}

function consentInput(request: FastifyRequest): Input | null {
  const type = request.headers['content-type']?.split(';', 1)[0].trim();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const bytes = Buffer.isBuffer(request.body) ? request.body : null;
  if (!bytes) return null;
  const values = new URLSearchParams(bytes.toString('utf8'));
  const [csrf, decision, write] = ['csrf', 'decision', 'write'].map((name) => values.getAll(name));
  if (csrf.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(csrf[0]) || decision.length !== 1
      || (decision[0] !== 'allow' && decision[0] !== 'cancel') || write.length > 1 || (write.length && write[0] !== 'yes')
      || values.size !== csrf.length + decision.length + write.length) return null;
  return { csrf: csrf[0], decision: decision[0], write: write.length === 1 };
}

function abortProviderReply(reply: FastifyReply) {
  if (reply.raw.headersSent) { reply.raw.destroy(); return; }
  reply.raw.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  reply.raw.end(JSON.stringify(unavailable));
}

function oauthError(reply: FastifyReply, error: unknown) {
  if (reply.sent) return;
  if (error instanceof errors.SessionNotFound || error instanceof errors.InvalidRequest) {
    return reply.code(400).header('Cache-Control', 'no-store').send(invalid);
  }
  return reply.code(503).header('Cache-Control', 'no-store').send(unavailable);
}

export function registerNativeOAuthRoutes(app: FastifyInstance, oauth: NativeOAuthRuntime) {
  const { origin, storage } = oauth;
  const metadata = oauthMetadata(origin);
  app.get(protectedResourceMetadataPath, { config }, (request, reply) => {
    if (canProxy(request, reply)) return reply.send(metadata.resourceMetadata);
  });
  app.get(issuerMetadataPath, { config }, (request, reply) => {
    if (canProxy(request, reply)) return reply.send(metadata.issuerMetadata);
  });
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', config, async onRequest(request, reply) {
    if (!canProxy(request, reply)) return;
    reply.header('Cache-Control', 'no-store');
    const token = /^Bearer ([A-Za-z0-9_-]{20,300})$/iu.exec(request.headers.authorization ?? '')?.[1];
    if (token) {
      try {
        const access = await oauth.request(() => storage.accessToken(token));
        if (access?.audience === metadata.resource && access.scope?.split(' ').includes(readScope)) {
          return reply.code(501).send({ error: 'unsupported_operation' });
        }
      } catch (error) { return oauthError(reply, error); }
    }
    return reply.code(401).header('WWW-Authenticate', metadata.challenge).send({ error: 'invalid_token' });
  }, handler: async () => {} });

  async function providerRequest(request: FastifyRequest, reply: FastifyReply) {
    if (!canProxy(request, reply)) return;
    if (request.routeOptions.url === authorizationPath && !readAuthorizationRequest(request, metadata.resource)) {
      return reply.code(400).header('Cache-Control', 'no-store').send(invalid);
    }
    if (request.routeOptions.url !== authorizationPath && request.routeOptions.url?.startsWith(authorizationPath)
        && !/^\/oauth\/authorize\/[A-Za-z0-9_-]{16,64}$/u.test(request.url)) {
      return reply.code(400).header('Cache-Control', 'no-store').send(invalid);
    }
    trustCanonicalRequest(request);
    try {
      await oauth.withProvider(async ({ callback }) => {
        reply.hijack();
        try { await callback(request.raw, reply.raw); }
        catch { abortProviderReply(reply); }
      });
    } catch (error) { return oauthError(reply, error); }
  }
  for (const [method, url] of [['GET', authorizationPath], ['GET', authorizationPath + '/:uid'], ['GET', keysPath], ['POST', tokenPath]] as const) {
    app.route({ method, url, config, onRequest: providerRequest, handler: async () => {} });
  }

  app.register(async (interaction) => {
    interaction.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer', bodyLimit: 4096 },
      (_request, body, done) => done(null, body));
    async function handle(request: FastifyRequest, reply: FastifyReply) {
      if (!canProxy(request, reply)) return;
      reply.headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      if (!isOAuthInteractionPath(request.url)) return reply.code(400).send(invalid);
      const uid = request.url.slice(interactionPath.length + 1);
      const decision = request.method === 'POST' && request.headers.origin === origin ? consentInput(request) : null;
      if (request.method === 'POST' && !decision) return reply.code(403).send({ error: 'access_denied' });
      trustCanonicalRequest(request);
      try {
        await oauth.withProvider(async ({ instance }) => {
          const pending = await instance.interactionDetails(request.raw, reply.raw);
          if (pending.uid !== uid) return reply.code(400).send(invalid);
          const { client_id, redirect_uri, scope } = pending.params;
          const client = oauth.clients.find(({ client_id: id }) => id === client_id);
          const scopes = requestedPlannerScopes(scope);
          if (!client || !scopes || typeof redirect_uri !== 'string' || !client.redirect_uris?.includes(redirect_uri)) {
            return reply.code(400).send(invalid);
          }
          const token = readSessionCookie(request.headers.cookie);
          const session = token && await storage.browserSession(token);
          if (!session) return decision ? reply.code(403).send({ error: 'access_denied' })
            : reply.redirect(workspaceSignInPath(request.url));
          const csrf = oauth.secrets.consent(session.generationId, uid, session.sessionId);
          const write = scopes.includes(writeScope);
          if (!decision) return reply.type('text/html; charset=utf-8').send(
            consentForm(csrf, session.account.actor.name, client.client_name ?? client.client_id, new URL(redirect_uri), write),
          );
          if (!token || !timingSafeEqual(Buffer.from(csrf), Buffer.from(decision.csrf)) || (decision.write && !write)) {
            return reply.code(403).send({ error: 'access_denied' });
          }
          const allowed = decision.decision === 'allow';
          const selected = allowed && decision.write ? readScope + ' ' + writeScope : readScope;
          const grantId = allowed ? randomUUID() : undefined;
          const actor = await storage.acceptConsent({ interactionId: uid, token, sessionId: session.sessionId,
            grantId, clientId: client.client_id, scope: selected });
          if (!actor) return reply.code(403).send({ error: 'access_denied' });
          await finishConsent(instance, request, reply, { actor, clientId: client.client_id, grantId,
            resource: metadata.resource, selected, rejectedWrite: write && !decision.write, factor: !!session.factorVerifiedAt });
        });
      } catch (error) { return oauthError(reply, error); }
    }
    interaction.get(interactionPath + '/:uid', { config }, handle);
    interaction.post(interactionPath + '/:uid', { config, bodyLimit: 4096 }, handle);
  });
}

async function finishConsent(provider: Provider, request: FastifyRequest, reply: FastifyReply, decision: {
  actor: string; clientId: string; grantId?: string; resource: string; selected: string; rejectedWrite: boolean; factor: boolean;
}) {
  const { actor, clientId, grantId, resource, selected, rejectedWrite, factor } = decision;
  if (grantId) {
    const grant = new provider.Grant({ accountId: actor, clientId });
    grant.jti = grantId;
    grant.addResourceScope(resource, selected);
    if (rejectedWrite) grant.rejectResourceScope(resource, writeScope);
    await grant.save();
  }
  reply.hijack();
  reply.raw.setHeader('Cache-Control', 'no-store');
  reply.raw.setHeader('Referrer-Policy', 'no-referrer');
  try {
    await provider.interactionFinished(request.raw, reply.raw, grantId
      ? { login: { accountId: actor, remember: false, amr: factor ? ['pwd', 'mfa'] : ['pwd'] }, consent: { grantId } }
      : { error: 'access_denied' }, { mergeWithLastSubmission: false });
  } catch { abortProviderReply(reply); }
}
