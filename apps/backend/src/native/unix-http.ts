import { chmod, lstat, unlink } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function socketInfo(path: string) {
  try { return await lstat(path); } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeStaleSocket(path: string, uid: number, gid: number, mode: number) {
  const previous = await socketInfo(path);
  if (!previous) return;
  if (!previous.isSocket() || previous.uid !== uid || previous.gid !== gid || previous.nlink !== 1
      || ![mode, 0o700].includes(previous.mode & 0o7777)) {
    throw new Error('The Planner HTTP socket has unexpected ownership or permissions.');
  }
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(path);
    connection.once('connect', () => {
      connection.destroy();
      reject(new Error('The Planner HTTP socket is in use.'));
    });
    connection.once('error', (error) => {
      if (errorCode(error) === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    connection.setTimeout(1_000, () => connection.destroy(new Error('Could not inspect the Planner HTTP socket.')));
  });
  const current = await socketInfo(path);
  if (current?.ino !== previous.ino || current.dev !== previous.dev) {
    throw new Error('The Planner HTTP socket changed during startup.');
  }
  await unlink(path);
}

export async function listenProtectedUnixHttp(server: Server, options: {
  directory: string;
  directoryMode: number;
  name: string;
  socketMode: number;
}) {
  const { directory, directoryMode, name, socketMode } = options;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const parent = await lstat(directory);
  if (uid === undefined || gid === undefined || !parent.isDirectory() || parent.uid !== uid || parent.gid !== gid
      || (parent.mode & 0o7777) !== directoryMode) {
    throw new Error('The Planner HTTP socket directory has unexpected ownership or permissions.');
  }
  const path = join(directory, name);
  await removeStaleSocket(path, uid, gid, socketMode);

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
    await chmod(path, socketMode);
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}
