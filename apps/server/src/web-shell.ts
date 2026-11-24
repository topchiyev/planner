import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const shellRoutes = [
  '/workspace',
  '/projects/:projectId',
  '/boards/:boardId',
  '/boards/:boardId/cards/:cardId',
];

export function registerWebShell(app: FastifyInstance, webRoot: string) {
  app.register(async (web) => {
    await web.register(fastifyStatic, {
      root: join(webRoot, 'assets'),
      prefix: '/assets/',
      index: false,
      maxAge: '1y',
      immutable: true,
    });

    web.get('/', (_request, reply) => reply.redirect('/workspace'));
    for (const route of shellRoutes.flatMap((path) => [path, `${path}/`])) {
      web.get<{ Params: Record<string, string> }>(route, (request, reply) => {
        if (Object.values(request.params).some((id) => id.length === 0)) {
          return reply.callNotFound();
        }
        reply.header('Cache-Control', 'no-store');
        return reply.sendFile('index.html', webRoot, { cacheControl: false });
      });
    }
  });
}
