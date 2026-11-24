import { createServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { markProxyRequest } from './http-boundary.js';
import { listenProtectedUnixHttp } from './unix-http.js';

export const proxyRuntimeDirectory = '/run/planner-proxy';

export async function startProxySocket(directory: string, app: FastifyInstance) {
  await app.ready();
  const server = createServer((request, reply) => {
    markProxyRequest(request);
    app.routing(request, reply);
  });
  return listenProtectedUnixHttp(server, { directory, directoryMode: 0o711, name: 'http.sock', socketMode: 0o666 });
}
