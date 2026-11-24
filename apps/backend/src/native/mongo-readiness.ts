import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  appUsername, assertMongoIdentity, databaseName, mongoClient, NativeMongoError, parseMongoCredentials, type MongoCredentials,
} from './mongo-identity.js';

export const mongoCredentialFile = '/etc/planner/mongodb-app.json';
export const mongoRuntimeDirectory = '/run/planner-mongodb';
export const mongoRuntimeSocket = `${mongoRuntimeDirectory}/mongod.sock`;
const run = promisify(execFile);

export async function assertLoopbackListener(port: number, uid: number) {
  const [ipv4, ipv6] = await Promise.all([
    readFile('/proc/net/tcp', 'utf8'),
    readFile('/proc/net/tcp6', 'utf8'),
  ]);
  const hexPort = port.toString(16).padStart(4, '0').toUpperCase();
  const listeners = (ipv4 + '\n' + ipv6).split('\n').map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields[3] === '0A' && fields[1]?.endsWith(`:${hexPort}`));
  if (listeners.length !== 1 || listeners[0][1] !== `0100007F:${hexPort}` || Number(listeners[0][7]) !== uid) {
    throw new NativeMongoError('The Planner database listener has unexpected ownership or binding.');
  }
}

export async function connectVerifiedNativeMongo(credentials: MongoCredentials) {
  await assertLoopbackListener(credentials.port, credentials.dbUid);
  const { stdout } = await run('/usr/bin/ss', ['-H', '-ltn', '--cgroup', `sport = :${credentials.port}`], {
    timeout: 1_000,
  });
  const listener = stdout.trim().split('\n');
  if (listener.length !== 1 || listener[0].split(/\s+/u)[3] !== `127.0.0.1:${credentials.port}`
      || !listener[0].split(/\s+/u).includes('cgroup:/system.slice/planner-mongodb.service')) {
    throw new NativeMongoError('The Planner database listener is outside its systemd service.');
  }
  const [runDirectory, directory, socket] = await Promise.all([
    lstat('/run'), lstat(mongoRuntimeDirectory), lstat(mongoRuntimeSocket),
  ]);
  if (!runDirectory.isDirectory() || runDirectory.uid !== 0 || runDirectory.gid !== 0 || (runDirectory.mode & 0o022) !== 0
      || !directory.isDirectory() || directory.uid !== credentials.dbUid || directory.gid !== credentials.dbGid
      || (directory.mode & 0o7777) !== 0o711 || !socket.isSocket() || socket.uid !== credentials.dbUid
      || socket.gid !== credentials.dbGid || socket.nlink !== 1 || (socket.mode & 0o7777) !== 0o777) {
    throw new NativeMongoError('The Planner database socket namespace has unexpected ownership or permissions.');
  }
  // The driver can reconnect and discover only this socket inside the owned namespace.
  const client = mongoClient(encodeURIComponent(mongoRuntimeSocket), databaseName, appUsername, credentials.password);
  try {
    await assertMongoIdentity(client, credentials.installationId);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function verifyNativeMongo(credentials: MongoCredentials) {
  await (await connectVerifiedNativeMongo(credentials)).close();
}

export async function connectConfiguredNativeMongo(expected?: { installationId: string; dbPort: number }) {
  const info = await lstat(mongoCredentialFile);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== process.getgid?.() || (info.mode & 0o7777) !== 0o640) {
    throw new NativeMongoError('The Planner database credentials have unsafe ownership or permissions.');
  }
  const credentials = parseMongoCredentials(JSON.parse(await readFile(mongoCredentialFile, 'utf8')));
  if (expected && (credentials.installationId !== expected.installationId || credentials.port !== expected.dbPort)) {
    throw new NativeMongoError('The Planner database credential does not match the application configuration.');
  }
  return connectVerifiedNativeMongo(credentials);
}

export async function checkMongoReadiness(expected?: { installationId: string; dbPort: number }) {
  await (await connectConfiguredNativeMongo(expected)).close();
}
