import { createServer } from 'node:http';
import { PLANNER_VERSION } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { accountErrors, AccountActionError } from '../application/auth/account-policy.js';
import type { AccountCredentials } from '../application/auth/account-credentials.js';
import type { RuntimeAccess } from './runtime-access.js';
import { listenProtectedUnixHttp } from './unix-http.js';

export const adminRuntimeDirectory = '/run/planner';

export async function startAdminSocket(
  directory: string, readAccess: () => Promise<RuntimeAccess>,
  accounts?: Pick<AccountCredentials, 'inspectApproval' | 'confirmApproval'>,
) {
  const server = createServer({ headersTimeout: 2_000, requestTimeout: 2_000, maxHeaderSize: 2_048 }, async (request, reply) => {
    reply.setHeader('Connection', 'close');
    reply.setHeader('Cache-Control', 'no-store');
    reply.setHeader('Content-Type', 'application/json');
    const unknown = () => reply.writeHead(404).end(JSON.stringify({ error: 'unknown operation' }));
    if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      unknown();
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      let access: RuntimeAccess;
      try { access = await readAccess(); } catch { access = { kind: 'unavailable', reason: 'probe' }; }
      reply.end(JSON.stringify({ version: PLANNER_VERSION, access }));
      return;
    }
    const match = /^\/accounts\/approvals\/([0-9a-f-]+)(\/confirm)?$/u.exec(request.url ?? '');
    const id = publicIdSchema.safeParse(match?.[1]);
    if (!accounts || !match || !id.success || request.method !== (match[2] ? 'POST' : 'GET')) {
      unknown();
      return;
    }
    try {
      const result = await (match[2] ? accounts.confirmApproval(id.data) : accounts.inspectApproval(id.data));
      reply.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof AccountActionError) {
        const [status, code, message] = accountErrors[error.kind];
        reply.writeHead(status).end(JSON.stringify({ code, message }));
      } else {
        reply.writeHead(503).end(JSON.stringify({ code: 'UNAVAILABLE', message: 'Planner is unavailable.' }));
      }
    }
  });
  server.setTimeout(5_000, (socket) => socket.destroy());
  return listenProtectedUnixHttp(server, { directory, directoryMode: 0o750, name: 'admin.sock', socketMode: 0o600 });
}
