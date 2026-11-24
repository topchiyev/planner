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
    plannerAccess: RuntimeAccess | null;
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

function isForwardingHeader(name: string) {
  return name.startsWith('x-forwarded-') || name.startsWith('x-planner-')
    || ['forwarded', 'x-real-ip', 'x-original-url', 'x-rewrite-url'].includes(name);
}

function sanitizeHeaders(request: FastifyRequest, authority: string) {
  const raw = request.raw;
  const distinct = raw.headersDistinct;
  for (const headers of [request.headers, raw.headers, distinct]) {
    if (!headers) continue;
    for (const name of Object.keys(headers)) {
      if (isForwardingHeader(name)) delete headers[name];
    }
  }
  raw.headers.host = authority;
  request.headers.host = authority;
  if (distinct) distinct.host = [authority];

  const rawHeaders = raw.rawHeaders;
  const sanitized: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (name !== 'host' && !isForwardingHeader(name)) sanitized.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  rawHeaders.splice(0, rawHeaders.length, ...sanitized, 'Host', authority);
}

export function registerNativeHttpBoundary(app: FastifyInstance, boundary: NativeHttpBoundary) {
  app.decorateRequest('plannerAccess', null);
  const authority = new URL(boundary.origin).host;
  const token = boundary.proxyToken === undefined ? undefined : Buffer.from(boundary.proxyToken, 'hex');
  app.addHook('onRequest', async (request, reply) => {
    const clientAddress = proxyAddress(request, authority, token);
    request.plannerConnection = { origin: boundary.origin, clientAddress };
    sanitizeHeaders(request, authority);

    const pathname = (request.raw.url ?? '').split('?', 1)[0];
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (read && (healthRoutes.has(pathname)
        || (request.routeOptions.url === '/assets/*' && /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(pathname)))) return;

    const access = await Promise.resolve().then(boundary.readAccess).catch(() => undefined);
    request.plannerAccess = access ?? null;
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
