import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const shellRoutes = [
  '/workspace',
  '/projects/:projectId',
  '/boards/:boardId',
  '/boards/:boardId/cards/:cardId',
];

export function registerFrontendShell(app: FastifyInstance, frontendRoot: string) {
  app.register(async (frontend) => {
    await frontend.register(fastifyStatic, {
      root: join(frontendRoot, 'assets'),
      prefix: '/assets/',
      index: false,
      maxAge: '1y',
      immutable: true,
    });

    frontend.get('/', (_request, reply) => reply.redirect('/workspace'));
    for (const route of shellRoutes.flatMap((path) => [path, `${path}/`])) {
      frontend.get<{ Params: Record<string, string> }>(route, (request, reply) => {
        if (Object.values(request.params).some((id) => id.length === 0)) {
          return reply.callNotFound();
        }
        reply.header('Cache-Control', 'no-store');
        return reply.sendFile('index.html', frontendRoot, { cacheControl: false });
      });
    }
  });
}
