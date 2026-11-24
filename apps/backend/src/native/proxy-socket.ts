import { createServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { markProxyRequest } from './http-boundary.js';
import { listenProtectedUnixHttp } from './unix-http.js';

export const proxyRuntimeDirectory = '/run/planner-proxy';

export async function startProxySocket(directory: string, app: FastifyInstance) {
  await app.ready();
  // The trusted proxy can forward a complete board filter sign-in URL plus its headers.
  const server = createServer({ maxHeaderSize: 32 * 1024 }, (request, reply) => {
    markProxyRequest(request);
    app.routing(request, reply);
  });
  return listenProtectedUnixHttp(server, { directory, directoryMode: 0o711, name: 'http.sock', socketMode: 0o666 });
}
