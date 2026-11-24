import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { PLANNER_VERSION } from '@planner/contracts';
import type { RuntimeAccess } from './runtime-access.js';

export const adminRuntimeDirectory = '/run/planner';

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function socketInfo(path: string) {
  try { return await lstat(path); } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeStaleSocket(path: string, uid: number, gid: number) {
  const previous = await socketInfo(path);
  if (!previous) return;
  if (!previous.isSocket() || previous.uid !== uid || previous.gid !== gid || previous.nlink !== 1
      || ![0o600, 0o700].includes(previous.mode & 0o7777)) {
    throw new Error('The Planner operator socket has unexpected ownership or permissions.');
  }
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(path);
    connection.once('connect', () => {
      connection.destroy();
      reject(new Error('The Planner operator socket is in use.'));
    });
    connection.once('error', (error) => {
      if (errorCode(error) === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    connection.setTimeout(1_000, () => connection.destroy(new Error('Could not inspect the Planner operator socket.')));
  });
  const current = await socketInfo(path);
  if (current?.ino !== previous.ino || current.dev !== previous.dev) {
    throw new Error('The Planner operator socket changed during startup.');
  }
  await unlink(path);
}

export async function startAdminSocket(directory: string, readAccess: () => Promise<RuntimeAccess>) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const parent = await lstat(directory);
  if (uid === undefined || gid === undefined || !parent.isDirectory() || parent.uid !== uid || parent.gid !== gid
      || (parent.mode & 0o7777) !== 0o750) {
    throw new Error('The Planner operator socket directory has unexpected ownership or permissions.');
  }
  const path = join(directory, 'admin.sock');
  await removeStaleSocket(path, uid, gid);

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
  const close = () => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chmod(path, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}
