import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance } from 'fastify';
import { createPlannerMcpHandler, mcpBodyLimit, mcpPath, type McpSurface } from '../application/mcp/http.js';
import { oauthMetadata, readScope } from '../application/oauth/provider.js';
import type { NativeOAuthRuntime } from './oauth-routes.js';

export function registerNativeMcpRoutes(app: FastifyInstance, oauth: NativeOAuthRuntime, surface?: McpSurface) {
  const { origin, registry, storage } = oauth;
  const { resource } = oauthMetadata(origin);
  const handler = createPlannerMcpHandler(origin, async (token) => {
    const access = await oauth.request(() => storage.accessToken(token));
    const scopes = access?.scope.split(' ') ?? [];
    if (!access || access.audience !== resource || !scopes.includes(readScope) || !registry.allowsId(access.clientId)) return null;
    return {
      generationId: access.generationId, userId: access.userId, clientId: access.clientId, grantId: access.grantId, scopes,
      read: (operation) => oauth.request(() => storage.withAccessTokenRead(token, (database, current) => {
        if (current.generationId !== access.generationId || current.userId !== access.userId || current.clientId !== access.clientId ||
          current.grantId !== access.grantId || current.audience !== resource || current.scope !== access.scope ||
          !registry.allowsId(current.clientId)) return Promise.resolve(null);
        return operation(database, {
          generationId: current.generationId, clientId: current.clientId, grantId: current.grantId, actor: current.actor,
        });
      })),
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
      await nodeHandler(request.raw, reply.raw, request.body);
    },
  });
  app.addHook('preClose', handler.close);
  return handler.close;
}
