import { randomUUID, timingSafeEqual, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import { isOAuthInteractionPath, oauthConnectionPageSchema, relationshipCommands, workspaceSignInPath } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import type Provider from 'oidc-provider';
import { errors } from 'oidc-provider';
import { readSessionCookie } from '../application/auth/credentials.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import { oauthSecrets } from '../application/oauth/keys.js';
import { acceptsClientRedirect, createOAuthClientRegistry, parseOAuthClientRegistrations, type PlannerOAuthClient } from '../application/oauth/clients.js';
import { createOAuthStorage } from '../application/oauth/storage.js';
import {
  authorizationPath, createPlannerProvider, interactionPath, issuerMetadataPath, keysPath, oauthMetadata,
  offlineScope, protectedResourceMetadataPath, readScope, requestedPlannerScopes, tokenPath, writeScope,
} from '../application/oauth/provider.js';
import { checkDirectory, packageAccount } from './mongo-host.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    plannerOAuth?: true;
  }
}

function nativeClientRegistrations() {
  checkDirectory('/etc/planner', 0, 0, 0o711);
  let file: number;
  try { file = openSync('/etc/planner/oauth-clients.json', constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== packageAccount('-g', 'planner') || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o640 || stat.size === 0 || stat.size > 32_768) throw new Error('Invalid Planner OAuth client file.');
    const bytes = Buffer.alloc(stat.size + 1);
    if (readSync(file, bytes) !== stat.size || fstatSync(file).ctimeMs !== stat.ctimeMs) throw new Error('Planner OAuth client file changed.');
    return parseOAuthClientRegistrations(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, stat.size))));
  } finally { closeSync(file); }
}

export function createNativeOAuth(config: NativeInstallationConfig, gate: CommandGate, key: KeyObject) {
  return createNativeOAuthRuntime(config.publicUrl, config.installationId, gate, key, async (operation) => {
    const client = await connectConfiguredNativeMongo(config);
    try { return await operation(client.db(databaseName)); }
    finally { await client.close(); }
  }, nativeClientRegistrations());
}

export function createNativeOAuthRuntime(
  origin: string, installationId: string, gate: CommandGate, key: KeyObject,
  withDatabase: <T>(run: (db: Db) => Promise<T>) => Promise<T>, clients: readonly PlannerOAuthClient[] = [], registry = createOAuthClientRegistry(clients),
  onGrantRevoked?: (identity: { generationId: string; grantId: string }) => void | Promise<void>,
) {
  const secrets = oauthSecrets(key, installationId);
  const storage = createOAuthStorage(installationId, gate, secrets);
  let provider: ReturnType<typeof loadProvider> | undefined;
  async function loadProvider(db: Db) {
    const instance = createPlannerProvider(origin, storage, secrets.cookies, await storage.keys(db), registry);
    return { instance, callback: instance.callback() };
  }
  return {
    origin, registry, storage, secrets,
    listConnections: (token: string, after?: string) => withDatabase((db) => storage.listConnections(db, token, after)),
    async revokeConnection(token: string, id: string) {
      const result = await withDatabase((db) => storage.revokeConnection(db, token, id));
      if (result) await onGrantRevoked?.(result);
      return result;
    },
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
type Input = { csrf: string; decision: 'allow' | 'cancel'; write: boolean; offline: boolean };

function trustCanonicalRequest(request: FastifyRequest) {
  // Native HTTP handling has already stripped client-controlled forwarding and Planner headers.
  request.raw.headers['x-forwarded-proto'] = 'https';
}

function canProxy(request: FastifyRequest, reply: FastifyReply) {
  if (request.plannerConnection?.clientAddress) return true;
  reply.code(403).header('Cache-Control', 'no-store').send({ error: 'access_denied' });
  return false;
}

async function readAuthorizationRequest(request: FastifyRequest, resource: string, registry: NativeOAuthRuntime['registry']) {
  const url = new URL(request.url, resource);
  const query = url.searchParams;
  const scopes = requestedPlannerScopes(query.get('scope'));
  if (query.getAll('resource').length !== 1 || query.get('resource') !== resource || query.getAll('scope').length !== 1 || !scopes
    || query.getAll('redirect_uri').length !== 1 || query.getAll('client_id').length !== 1) return false;
  const client = await registry.resolve(query.get('client_id')!).catch(() => null);
  if (!client || !acceptsClientRedirect(client, query.get('redirect_uri')!)) return false;
  if (scopes.includes(offlineScope) && !query.has('prompt')) {
    query.set('prompt', 'consent');
    request.raw.url = url.pathname + url.search;
  }
  return true;
}

function consentForm(csrf: string, account: string, client: string, redirect: URL, write: boolean, offline: boolean) {
  const escape = (text: string) => text.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect to Planner</title><main>
<h1>Connect to Planner</h1><p>Signed in as ${escape(account)}.</p>
<p>${escape(client)} is requesting access to read your Planner workspace. Planner will return you to ${escape(redirect.host)}.</p>
<form method="post"><input type="hidden" name="csrf" value="${escape(csrf)}">
${write ? '<label><input type="checkbox" name="write" value="yes"> Allow changes you have permission to make</label>' : ''}
${offline ? '<label><input type="checkbox" name="offline" value="yes"> Keep this connection available between sign-ins</label>' : ''}
<button name="decision" value="allow">Allow</button><button name="decision" value="cancel">Cancel</button>
</form></main></html>`;
}

function consentInput(request: FastifyRequest): Input | null {
  const type = request.headers['content-type']?.split(';', 1)[0].trim();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const bytes = Buffer.isBuffer(request.body) ? request.body : null;
  if (!bytes) return null;
  const values = new URLSearchParams(bytes.toString('utf8'));
  const [csrf, decision, write, offline] = ['csrf', 'decision', 'write', 'offline'].map((name) => values.getAll(name));
  if (csrf.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(csrf[0]) || decision.length !== 1
      || (decision[0] !== 'allow' && decision[0] !== 'cancel')
      || [write, offline].some((choice) => choice.length > 1 || (choice.length && choice[0] !== 'yes'))
      || values.size !== csrf.length + decision.length + write.length + offline.length) return null;
  return { csrf: csrf[0], decision: decision[0], write: write.length === 1, offline: offline.length === 1 };
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

const operatorCommands = new Set(['projects.delete', 'boards.delete', 'cards.purge', 'lists.clearTrash']);
const writeTools = new Set(Object.keys(relationshipCommands).filter((operation) => !operatorCommands.has(operation)).map((operation) => {
  const [collection, action] = operation.split('.');
  return collection.slice(0, -1) + '_' + action.replace(/[A-Z]/gu, (letter) => '_' + letter.toLowerCase());
}));

function requestsWorkspaceMutation(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  return method === 'tools/call' && typeof params?.name === 'string' && writeTools.has(params.name);
}

export function registerNativeOAuthRoutes(app: FastifyInstance, oauth: NativeOAuthRuntime) {
  const { origin, registry, storage } = oauth;
  const metadata = oauthMetadata(origin);
  app.get(protectedResourceMetadataPath, { config }, (request, reply) => {
    if (canProxy(request, reply)) return reply.send(metadata.resourceMetadata);
  });
  app.get(issuerMetadataPath, { config }, (request, reply) => {
    if (canProxy(request, reply)) return reply.send(metadata.issuerMetadata);
  });
  const permitsWrites = new WeakMap<FastifyRequest, boolean>();
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', config, async onRequest(request, reply) {
    if (!canProxy(request, reply)) return;
    reply.header('Cache-Control', 'no-store');
    const token = /^Bearer ([A-Za-z0-9_-]{20,300})$/iu.exec(request.headers.authorization ?? '')?.[1];
    if (token) {
      try {
        const access = await oauth.request(() => storage.accessToken(token));
        const scopes = access?.scope?.split(' ') ?? [];
        if (access?.audience === metadata.resource && scopes.includes(readScope) && registry.allowsId(access.clientId)) {
          permitsWrites.set(request, scopes.includes(writeScope));
          return;
        }
      } catch (error) { return oauthError(reply, error); }
    }
    return reply.code(401).header('WWW-Authenticate', metadata.challenge).send({ error: 'invalid_token' });
  }, async handler(request, reply) {
    if (!permitsWrites.get(request) && requestsWorkspaceMutation(request.body)) {
      return reply.code(403).header('WWW-Authenticate',
        `Bearer error="insufficient_scope", scope="${readScope} ${writeScope}", resource_metadata="${origin + protectedResourceMetadataPath}"`)
        .send({ error: 'insufficient_scope' });
    }
    return reply.code(501).send({ error: 'unsupported_operation' });
  } });

  async function providerRequest(request: FastifyRequest, reply: FastifyReply) {
    if (!canProxy(request, reply)) return;
    if (request.routeOptions.url === authorizationPath && !await readAuthorizationRequest(request, metadata.resource, registry)) {
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
  for (const url of [authorizationPath, authorizationPath + '/:uid', keysPath]) {
    app.get(url, { config, onRequest: providerRequest }, async () => {});
  }

  app.register(async (tokens) => {
    tokens.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer', bodyLimit: 8192 },
      (_request, body, done) => done(null, body));
    tokens.post(tokenPath, { config, bodyLimit: 8192 }, async (request, reply) => {
      if (!canProxy(request, reply)) return;
      reply.header('Cache-Control', 'no-store');
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send(invalid);
      const params = new URLSearchParams(request.body.toString('utf8'));
      const fields = new Set(params.keys());
      if (fields.size !== params.size) return reply.code(400).send(invalid);
      const flow = params.get('grant_type');
      if (flow !== 'authorization_code' && flow !== 'refresh_token') return reply.code(400).send({ error: 'unsupported_grant_type' });
      if (flow === 'authorization_code' && !params.get('redirect_uri')) return reply.code(400).send(invalid);
      const allowed = flow === 'authorization_code' ? ['code', 'code_verifier', 'redirect_uri'] : ['refresh_token', 'scope'];
      for (const field of ['grant_type', 'client_id', 'resource', ...allowed]) fields.delete(field);
      if (fields.size || request.headers.authorization !== undefined) return reply.code(400).send(invalid);
      const requested = params.get('resource');
      if (requested !== null && requested !== metadata.resource) return reply.code(400).send({ error: 'invalid_target' });
      if (flow === 'refresh_token' && params.has('scope') && !requestedPlannerScopes(params.get('scope'))) {
        return reply.code(400).send({ error: 'invalid_scope' });
      }
      // oidc-provider accepts a parsed upstream form on an already consumed request stream.
      Object.assign(request.raw, { body: request.body });
      return providerRequest(request, reply);
    });
  });

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
          const client = typeof client_id === 'string' && await registry.resolve(client_id).catch(() => null);
          const scopes = requestedPlannerScopes(scope);
          if (!client || !scopes || typeof redirect_uri !== 'string' || !acceptsClientRedirect(client, redirect_uri)) {
            return reply.code(400).send(invalid);
          }
          const token = readSessionCookie(request.headers.cookie);
          const session = token && await storage.browserSession(token);
          if (!session) return decision ? reply.code(403).send({ error: 'access_denied' })
            : reply.redirect(workspaceSignInPath(request.url));
          const csrf = oauth.secrets.consent(session.generationId, uid, session.sessionId);
          const write = scopes.includes(writeScope);
          const offline = scopes.includes(offlineScope);
          if (!decision) return reply.type('text/html; charset=utf-8').send(
            consentForm(csrf, session.account.actor.name, client.client_name, new URL(redirect_uri), write, offline),
          );
          if (!token || !timingSafeEqual(Buffer.from(csrf), Buffer.from(decision.csrf)) || (decision.write && !write) || (decision.offline && !offline)) {
            return reply.code(403).send({ error: 'access_denied' });
          }
          const allowed = decision.decision === 'allow';
          const selected = allowed && decision.write ? readScope + ' ' + writeScope : readScope;
          const offlineAccepted = allowed && decision.offline;
          const grantId = allowed ? randomUUID() : undefined;
          const actor = await storage.acceptConsent({ interactionId: uid, token, sessionId: session.sessionId,
            grantId, clientId: client.client_id, clientName: client.client_name, scope: selected, resource: metadata.resource, offline: offlineAccepted });
          if (!actor) return reply.code(403).send({ error: 'access_denied' });
          await finishConsent(instance, request, reply, { actor, clientId: client.client_id, grantId,
            resource: metadata.resource, selected, offlineAccepted, rejectedOffline: offline && !decision.offline, rejectedWrite: write && !decision.write, factor: !!session.factorVerifiedAt });
        });
      } catch (error) { return oauthError(reply, error); }
    }
    interaction.get(interactionPath + '/:uid', { config }, handle);
    interaction.post(interactionPath + '/:uid', { config, bodyLimit: 4096 }, handle);
  });
}

async function finishConsent(provider: Provider, request: FastifyRequest, reply: FastifyReply, decision: {
  actor: string; clientId: string; grantId?: string; resource: string; selected: string; offlineAccepted: boolean; rejectedOffline: boolean; rejectedWrite: boolean; factor: boolean;
}) {
  const { actor, clientId, grantId, resource, selected, offlineAccepted, rejectedOffline, rejectedWrite, factor } = decision;
  if (grantId) {
    const grant = new provider.Grant({ accountId: actor, clientId });
    grant.jti = grantId;
    grant.addResourceScope(resource, selected);
    if (offlineAccepted) grant.addOIDCScope(offlineScope);
    if (rejectedOffline) grant.rejectOIDCScope(offlineScope);
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

export function registerOAuthConnectionRoutes(app: FastifyInstance, oauth?: NativeOAuthRuntime) {
  function browserToken(request: FastifyRequest) {
    return request.plannerConnection?.clientAddress && request.plannerSession && readSessionCookie(request.headers.cookie);
  }
  app.get('/api/v1/me/connections', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = browserToken(request);
    if (!token) return reply.code(401).send({ error: 'access_denied' });
    const query = request.query as Record<string, unknown>;
    const cursor = Object.hasOwn(query, 'after') ? publicIdSchema.safeParse(query.after) : undefined;
    if ((cursor && !cursor.success) || Object.keys(query).some((field) => field !== 'after')) return reply.code(400).send(invalid);
    try {
      const page = oauth ? await oauth.listConnections(token, cursor?.data) : { connections: [], next: null };
      if (!page) return reply.code(401).send({ error: 'access_denied' });
      return oauthConnectionPageSchema.parse(page);
    } catch { return reply.code(503).send(unavailable); }
  });
  app.delete<{ Params: { id: string } }>('/api/v1/me/connections/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = browserToken(request);
    if (!token) return reply.code(401).send({ error: 'access_denied' });
    const id = publicIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    try {
      const result = oauth ? await oauth.revokeConnection(token, id.data) : false;
      if (result === null) return reply.code(401).send({ error: 'access_denied' });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    } catch { return reply.code(503).send(unavailable); }
  });
}
