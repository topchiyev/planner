import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

const shellRoutes = [
  '/workspace',
  '/projects/:projectId',
  '/boards/:boardId',
  '/boards/:boardId/cards/:cardId',
];

export function registerFrontendShell(app: FastifyInstance, frontendRoot: string, native: boolean, browserAuth: boolean) {
  app.register(async (frontend) => {
    const nativeIndex = browserAuth
      ? (await readFile(join(frontendRoot, 'index.html'), 'utf8')).replace(
        '</head>', '<meta name="planner-browser-auth" content="required" /></head>',
      )
      : undefined;
    function sendShell(reply: FastifyReply) {
      reply.header('Cache-Control', 'no-store');
      return nativeIndex === undefined
        ? reply.sendFile('index.html', frontendRoot, { cacheControl: false })
        : reply.type('text/html; charset=utf-8').send(nativeIndex);
    }
    await frontend.register(fastifyStatic, {
      root: join(frontendRoot, 'assets'),
      prefix: '/assets/',
      index: false,
      maxAge: '1y',
      immutable: true,
    });

    frontend.get('/', (_request, reply) => reply.redirect('/workspace'));
    if (native) {
      frontend.get('/recover', (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        if (browserAuth && request.plannerAccess?.kind === 'ready') return reply.redirect('/sign-in');
        return sendShell(reply);
      });
      if (browserAuth) frontend.get('/sign-in', (_request, reply) => {
        return sendShell(reply);
      });
      else frontend.get('/enroll-mfa', (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/html').send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Multi-factor enrollment · Planner</title><h1>Multi-factor enrollment</h1></html>',
      ));
    }
    for (const route of shellRoutes.flatMap((path) => [path, `${path}/`])) {
      frontend.get<{ Params: Record<string, string> }>(route, (request, reply) => {
        if (Object.values(request.params).some((id) => id.length === 0)) {
          return reply.callNotFound();
        }
        return sendShell(reply);
      });
    }
  });
}
