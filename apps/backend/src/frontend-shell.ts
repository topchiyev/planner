import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const shellRoutes = [
  '/workspace',
  '/projects/:projectId',
  '/boards/:boardId',
  '/boards/:boardId/cards/:cardId',
];

export function registerFrontendShell(app: FastifyInstance, frontendRoot: string, native: boolean) {
  app.register(async (frontend) => {
    await frontend.register(fastifyStatic, {
      root: join(frontendRoot, 'assets'),
      prefix: '/assets/',
      index: false,
      maxAge: '1y',
      immutable: true,
    });

    frontend.get('/', (_request, reply) => reply.redirect('/workspace'));
    if (native) {
      for (const [page, title] of [['/recover', 'Administrator enrollment'], ['/enroll-mfa', 'Multi-factor enrollment']]) {
        frontend.get(page, (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/html').send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title} · Planner</title><h1>${title}</h1></html>`,
        ));
      }
    }
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
