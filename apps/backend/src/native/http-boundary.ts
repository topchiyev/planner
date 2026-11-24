import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RuntimeAccess } from './runtime-access.js';

interface ConnectionContext {
  origin: string;
  clientAddress: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    plannerConnection: ConnectionContext | null;
  }
}

export interface NativeHttpBoundary {
  origin: string;
  proxyToken?: string;
  readAccess: () => Promise<RuntimeAccess>;
}

export const proxyTokenPattern = /^[0-9a-f]{64}$/u;
const proxyHeader = 'x-planner-proxy-token';
const healthRoutes = new Set(['/health/live', '/health/ready']);
const mfaMethods = new Set(['/api/v1/mfa/enrollment', '/api/v1/mfa/enrollment/verify']);
const proxyRequests = new WeakSet<IncomingMessage>();

export function markProxyRequest(request: IncomingMessage) {
  proxyRequests.add(request);
}

function proxyAddress(request: FastifyRequest, authority: string, token?: Buffer) {
  const headers = request.headers;
  const supplied = headers[proxyHeader];
  const address = headers['x-forwarded-for'];
  if (!proxyRequests.has(request.raw) || !token
      || typeof supplied !== 'string' || !proxyTokenPattern.test(supplied)
      || !timingSafeEqual(token, Buffer.from(supplied, 'hex'))
      || headers['x-forwarded-host'] !== authority || headers['x-forwarded-proto'] !== 'https'
      || typeof address !== 'string' || isIP(address) === 0) return null;
  return address;
}

export function registerNativeHttpBoundary(app: FastifyInstance, boundary: NativeHttpBoundary) {
  const authority = new URL(boundary.origin).host;
  const token = boundary.proxyToken === undefined ? undefined : Buffer.from(boundary.proxyToken, 'hex');
  app.addHook('onRequest', async (request, reply) => {
    const clientAddress = proxyAddress(request, authority, token);
    request.plannerConnection = { origin: boundary.origin, clientAddress };
    for (const name of Object.keys(request.headers)) {
      if (name.startsWith('x-forwarded-') || name.startsWith('x-planner-')
          || ['forwarded', 'x-real-ip', 'x-original-url', 'x-rewrite-url'].includes(name)) {
        delete request.headers[name];
      }
    }
    request.headers.host = authority;

    const pathname = (request.raw.url ?? '').split('?', 1)[0];
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (read && (healthRoutes.has(pathname)
        || (request.routeOptions.url === '/assets/*' && /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(pathname)))) return;

    const access = await Promise.resolve().then(boundary.readAccess).catch(() => undefined);
    if (access?.kind === 'ready') return;
    if (access?.kind === 'enrollment') {
      if (read && pathname === (access.step === 'recovery' ? '/recover' : '/enroll-mfa')) return;
      const allowed = access.step === 'recovery' ? pathname === '/api/v1/recovery/consume' : mfaMethods.has(pathname);
      if (allowed && request.method === 'POST' && request.headers.origin === boundary.origin && clientAddress) return;
    }
    return reply.code(503).header('Cache-Control', 'no-store').send({
      error: { code: 'UNAVAILABLE', message: 'Planner is unavailable.', requestId: request.id },
    });
  });
}
