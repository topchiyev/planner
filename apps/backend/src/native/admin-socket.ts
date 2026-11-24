import { createServer } from 'node:http';
import { PLANNER_VERSION } from '@planner/contracts';
import type { RuntimeAccess } from './runtime-access.js';
import { listenProtectedUnixHttp } from './unix-http.js';

export const adminRuntimeDirectory = '/run/planner';

export async function startAdminSocket(directory: string, readAccess: () => Promise<RuntimeAccess>) {
  const server = createServer({ headersTimeout: 2_000, requestTimeout: 2_000, maxHeaderSize: 2_048 }, async (request, reply) => {
    reply.setHeader('Connection', 'close');
    reply.setHeader('Cache-Control', 'no-store');
    reply.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/status' || request.headers['transfer-encoding']
        || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      reply.writeHead(404).end(JSON.stringify({ error: 'unknown operation' }));
      return;
    }
    let access: RuntimeAccess;
    try { access = await readAccess(); } catch { access = { kind: 'unavailable', reason: 'probe' }; }
    reply.end(JSON.stringify({ version: PLANNER_VERSION, access }));
  });
  server.setTimeout(5_000, (socket) => socket.destroy());
  return listenProtectedUnixHttp(server, { directory, directoryMode: 0o750, name: 'admin.sock', socketMode: 0o600 });
}
