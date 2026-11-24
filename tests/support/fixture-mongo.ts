import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Db, MongoClient, MongoClientOptions } from 'mongodb';
import { assertOwnedMongoEnvironment } from './mongo-environment.ts';

export const mongoFixtureDirectoryPrefix = '/tmp/planner-mongo-';
const database = 'planner_fixture';
const driverTimeouts: MongoClientOptions = {
  connectTimeoutMS: 1_000,
  serverSelectionTimeoutMS: 4_000,
  socketTimeoutMS: 4_000,
  maxPoolSize: 2,
};

export interface FixtureMongo {
  client: MongoClient;
  db: Db;
  anonymousDb: Db;
  directory: string;
  socketPath: string;
  pid: number;
}

function startMongod(directory: string, socketPath: string) {
  const child = spawn('mongod', [
    '--dbpath', join(directory, 'db'),
    '--bind_ip', socketPath, '--port', '0', '--nounixsocket', '--auth',
    '--setParameter', 'diagnosticDataCollectionEnabled=false',
    '--wiredTigerCacheSizeGB', '0.25',
    '--logpath', join(directory, 'mongod.log'),
  ], { cwd: directory, stdio: 'ignore', env: { PATH: process.env.PATH, LC_ALL: 'C' } });

  // The close event reaps the owned process, including when its executable cannot start.
  const closed = new Promise<true>((resolve) => {
    child.once('error', () => {});
    child.once('close', () => resolve(true));
  });
  return { child, closed };
}

type OwnedMongod = ReturnType<typeof startMongod>;

async function waitForSocket({ child }: OwnedMongod, socketPath: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const file = await lstat(socketPath).catch(() => undefined);
    if (file?.isSocket()) return;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) break;
    await delay(50);
  }
  throw new Error('MongoDB fixture did not create its Unix socket.');
}

async function stopMongod({ child, closed }: OwnedMongod) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([closed, delay(4_000, undefined, { ref: false })]);
  if (stopped) return;
  child.kill('SIGKILL');
  const killed = await Promise.race([closed, delay(2_000, undefined, { ref: false })]);
  if (!killed) throw new Error('Could not confirm termination of the owned MongoDB fixture.');
}

function newAccount(role: string) {
  return {
    username: `planner_${role}_${randomBytes(8).toString('hex')}`,
    password: randomBytes(32).toString('hex'),
  };
}

export async function withFixtureMongo<T>(run: (fixture: FixtureMongo) => Promise<T>): Promise<T> {
  assertOwnedMongoEnvironment(process.env);
  const { MongoClient } = await import('mongodb');
  const directory = await mkdtemp(mongoFixtureDirectoryPrefix);
  const socketPath = join(directory, 'mongod.sock');
  const uri = `mongodb://${encodeURIComponent(socketPath)}/${database}?directConnection=true`;
  const bootstrapAccount = newAccount('bootstrap');
  const appAccount = newAccount('test');
  let server: OwnedMongod | undefined;
  let client: MongoClient | undefined;
  let anonymous: MongoClient | undefined;

  try {
    try {
      await chmod(directory, 0o700);
      await mkdir(join(directory, 'db'), { mode: 0o700 });
      server = startMongod(directory, socketPath);
      await waitForSocket(server, socketPath);
      anonymous = new MongoClient(uri, driverTimeouts);
      // Before any users exist, MongoDB permits creation of one admin through this local socket.
      await anonymous.db('admin').command({
        createUser: bootstrapAccount.username,
        pwd: bootstrapAccount.password,
        roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }],
      });
      const bootstrap = new MongoClient(uri, { ...driverTimeouts, authSource: 'admin', auth: bootstrapAccount });
      try {
        await bootstrap.db(database).command({
          createUser: appAccount.username,
          pwd: appAccount.password,
          roles: [{ role: 'readWrite', db: database }],
        });
        await bootstrap.db('admin').command({ dropUser: bootstrapAccount.username });
      } finally {
        await bootstrap.close();
      }
      client = new MongoClient(uri, { ...driverTimeouts, authSource: database, auth: appAccount });
      await client.connect();
    } catch {
      throw new Error('Could not start the isolated MongoDB fixture. Check that MongoDB 8 is available on PATH.');
    }

    return await run({ client, db: client.db(database), anonymousDb: anonymous.db(database), directory, socketPath, pid: server.child.pid! });
  } finally {
    try {
      await Promise.all([client?.close(), anonymous?.close()]);
    } finally {
      if (server) await stopMongod(server);
      await rm(directory, { force: true, recursive: true });
    }
  }
}
