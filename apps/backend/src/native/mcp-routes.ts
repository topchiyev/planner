import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance } from 'fastify';
import { createPlannerMcpHandler, mcpBodyLimit, mcpPath, type McpSurface } from '../application/mcp/http.js';
import { executeMcpMutation } from '../application/mcp/mutations.js';
import type { AfterCommandCommit } from '../application/command-journal/journal.js';
import { createMediaService } from '../application/media/service.js';
import type { MediaDecoder } from '../application/media/decoder.js';
import { WorkspaceAccessError, createWorkspaceAuthorization } from '../application/workspace/authorization.js';
import type { PrivateMediaStore } from '../storage/blobs/private-store.js';
import { oauthMetadata, readScope, writeScope } from '../application/oauth/provider.js';
import type { NativeOAuthRuntime } from './oauth-routes.js';
import { serveNativeMcpSubscription } from './mcp-subscriptions.js';
import type { McpListenAccess, McpListenProof } from '../application/mcp/board-subscriptions.js';

export interface NativeMcpWrites {
  store: PrivateMediaStore;
  decode: MediaDecoder;
  onCommitted?: () => void;
  afterCommit?: AfterCommandCommit;
}

export function registerNativeMcpRoutes(app: FastifyInstance, oauth: NativeOAuthRuntime, surface?: McpSurface, writes?: NativeMcpWrites) {
  const { origin, registry, storage } = oauth;
  const { resource } = oauthMetadata(origin);
  const handler = createPlannerMcpHandler(origin, async (token) => {
    const access = await oauth.request(() => storage.accessToken(token));
    const scopes = access?.scope.split(' ') ?? [];
    if (!access || access.audience !== resource || !scopes.includes(readScope) || !registry.allowsId(access.clientId)) return null;
    type Binding = NonNullable<typeof access>;
    const matches = (current: Binding) => current.generationId === access.generationId && current.userId === access.userId &&
      current.clientId === access.clientId && current.grantId === access.grantId && current.audience === resource &&
      current.scope === access.scope && registry.allowsId(current.clientId);
    const clientId = writes && scopes.includes(writeScope) ? registry.auditId(access.clientId) : null;
    const listenProof = (current: Binding & Pick<McpListenProof, 'actor' | 'expiresAtMs'>): McpListenProof => ({
      generationId: current.generationId, clientId: current.clientId, grantId: current.grantId, actor: current.actor,
      expiresAtMs: current.expiresAtMs, valid: () => storage.accessDeliveryCurrent(current.expiresAtMs),
    });
    const listen: McpListenAccess | undefined = surface?.boardSubscriptions && {
      tokenId: access.tokenId,
      read: (operation) => oauth.request(() => storage.withAccessTokenRead(token, (database, current) => {
        if (!matches(current) || current.tokenId !== access.tokenId) return Promise.resolve(null);
        return operation(database, listenProof(current));
      })),
      async currentUnderWriter(database) {
        const current = await storage.currentAccessTokenForCommand(database, access.generationId, token);
        if (!current || !matches(current) || current.tokenId !== access.tokenId) return null;
        return listenProof(current);
      },
    };
    return {
      generationId: access.generationId, userId: access.userId, clientId: access.clientId, grantId: access.grantId, scopes, listen,
      read: (operation) => oauth.request(() => storage.withAccessTokenRead(token, (database, current) => {
        if (!matches(current)) return Promise.resolve(null);
        return operation(database, {
          generationId: current.generationId, clientId: current.clientId, grantId: current.grantId, actor: current.actor,
        });
      })),
      ...(writes && clientId && { write: (name: string, input: unknown) =>
        oauth.withCommandDatabase(async (database, gate, installationId) => {
          let expiresAtMs = Infinity;
          try {
            return await executeMcpMutation({
              database, gate, installationId, actorId: access.userId,
              attribution: { origin: 'mcp', clientId },
              media: createMediaService(database, installationId, gate, writes.store, writes.decode, { afterCommit: writes.afterCommit }),
              afterCommit: writes.afterCommit, onCommitted: writes.onCommitted,
              async resolve({ actorId, generationId }) {
                if (actorId !== access.userId || generationId !== access.generationId) throw new WorkspaceAccessError('session');
                const current = await storage.currentAccessTokenForCommand(database, generationId, token);
                if (!current || !matches(current) || registry.auditId(current.clientId) !== clientId) throw new WorkspaceAccessError('session');
                expiresAtMs = Math.min(expiresAtMs, current.expiresAtMs);
                return createWorkspaceAuthorization(database, generationId, current.actor);
              },
            }, name, input);
          } finally {
            // Check both committed receipts and data attached to typed rejections (such as stale placement).
            // A response deadline never rolls back the durable command or alters its same-key receipt.
            if (!storage.accessTokenProofCurrent(expiresAtMs)) throw new WorkspaceAccessError('session');
          }
        }) }),
    };
  }, surface);
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: mcpBodyLimit });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: mcpPath,
    config: { plannerOAuth: true },
    bodyLimit: mcpBodyLimit,
    async onRequest(request, reply) {
      reply.header('Cache-Control', 'no-store');
      if (!request.plannerConnection?.clientAddress || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
        return reply.code(403).send({ error: 'access_denied' });
      }
      if (request.method !== 'POST') return reply.code(405).header('Allow', 'POST').send({
        jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' },
      });
    },
    async handler(request, reply) {
      reply.hijack();
      reply.raw.setHeader('Cache-Control', 'no-store');
      const body = request.body;
      if (surface?.boardSubscriptions && body && typeof body === 'object' && 'method' in body && body.method === 'subscriptions/listen') {
        return serveNativeMcpSubscription(handler, request.raw, reply.raw, body);
      }
      await nodeHandler(request.raw, reply.raw, body);
    },
  });
  app.addHook('preClose', handler.close);
  return handler.close;
}
