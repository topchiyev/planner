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
    for (const route of shellRoutes) {
      web.get(route, (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return reply.sendFile('index.html', webRoot, { cacheControl: false });
      });
    }
  });
}
