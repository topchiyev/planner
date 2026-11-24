import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  appUsername, assertMongoIdentity, databaseName, mongoClient, provisionMongoIdentity,
} from '../../apps/backend/src/native/mongo-identity.ts';
import { assertLoopbackListener } from '../../apps/backend/src/native/mongo-readiness.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);

async function ownedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check) {
  for (let count = 0; ; count += 1) {
    try {
      return await check();
    } catch (error) {
      if (count === 149) throw error;
      await delay(50);
    }
  }
}

async function assertChildOwnsSocket(pid, inode) {
  const directory = `/proc/${pid}/fd`;
  const files = await readdir(directory);
  const handles = await Promise.all(files.map((file) => readlink(join(directory, file)).catch(() => undefined)));
  assert.ok(inode && handles.includes(`socket:[${inode}]`), 'the spawned MongoDB must own this listening socket');
}

async function assertOwnedUnixSocket(path, pid, mode) {
  const info = await lstat(path);
  assert.equal(info.isSocket(), true);
  assert.equal(info.mode & 0o7777, mode);
  const sockets = (await readFile('/proc/net/unix', 'utf8')).split('\n').map((line) => line.trim().split(/\s+/u));
  const socket = sockets.find((fields) => fields[7] === path && fields[3] === '00010000' && fields[4] === '0001');
  await assertChildOwnsSocket(pid, socket?.[6]);
}

async function assertOwnedTcpPort(port, pid, uid) {
  await assertLoopbackListener(port, uid);
  const endpoint = `0100007F:${port.toString(16).padStart(4, '0').toUpperCase()}`;
  const sockets = (await readFile('/proc/net/tcp', 'utf8')).split('\n').map((line) => line.trim().split(/\s+/u));
  const socket = sockets.find((fields) => fields[1] === endpoint && fields[3] === '0A');
  await assertChildOwnsSocket(pid, socket?.[9]);
}

async function privateMongo(directory, configuration) {
  const config = join(directory, 'mongod.conf');
  await writeFile(config, JSON.stringify({
    storage: { dbPath: join(directory, 'db'), wiredTiger: { engineConfig: { cacheSizeGB: 0.25 } } },
    systemLog: { destination: 'file', path: join(directory, 'mongod.log'), logAppend: true },
    net: {
      ...configuration.net,
      unixDomainSocket: { enabled: false, filePermissions: configuration.localhostBypass ? 0o700 : 0o777 },
    },
    security: { authorization: 'enabled' },
    setParameter: {
      diagnosticDataCollectionEnabled: false,
      enableLocalhostAuthBypass: configuration.localhostBypass,
    },
  }), { mode: 0o600 });
  const process = spawn('mongod', ['--config', config], { stdio: 'ignore' });
  const done = once(process, 'close');
  // An absent mongod must still reach the awaited error path.
  void done.catch(() => {});
  return {
    process,
    async stop() {
      process.kill();
      const force = setTimeout(() => process.kill('SIGKILL'), 4_000);
      try { await done; } finally { clearTimeout(force); }
    },
  };
}

test('owned MongoDB provisions a fresh installation in one call', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planner-native-mongo-first-'));
  const socket = join(directory, 'mongod.sock');
  const endpoint = encodeURIComponent(socket);
  const credentials = {
    installationId: randomUUID(), dbUid: process.getuid(), dbGid: process.getgid(), port: 27431,
    password: randomBytes(32).toString('hex'),
  };
  const temporaryPassword = randomBytes(32).toString('hex');
  const app = mongoClient(endpoint, databaseName, appUsername, credentials.password);
  const admin = mongoClient(endpoint, 'admin', 'planner-bootstrap', temporaryPassword);
  let server;
  try {
    await mkdir(join(directory, 'db'), { mode: 0o700 });
    server = await privateMongo(directory, { net: { bindIp: socket, port: 0 }, localhostBypass: true });
    assert.ok(server.process.pid);
    await waitFor(() => assertOwnedUnixSocket(socket, server.process.pid, 0o700));
    let checkpoints = 0;
    await provisionMongoIdentity(socket, credentials, temporaryPassword, true, async () => { checkpoints += 1; });
    assert.equal(checkpoints, 1);
    await assertMongoIdentity(app, credentials.installationId);
    await assert.rejects(admin.connect(), { code: 18 });
  } finally {
    await Promise.all([app.close(), admin.close()]);
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('owned MongoDB resumes bootstrap and preserves the exact app role and installation across restart', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planner-native-mongo-'));
  const socket = join(directory, 'mongod.sock');
  const permanentSocket = join(directory, 'permanent.sock');
  const port = await ownedPort();
  const credentials = {
    installationId: randomUUID(), dbUid: process.getuid(), dbGid: process.getgid(), port,
    password: randomBytes(32).toString('hex'),
  };
  const temporaryPassword = randomBytes(32).toString('hex');
  let server;
  const clients = [];
  function connect(endpoint, db, username, password) {
    const client = mongoClient(endpoint, db, username, password);
    clients.push(client);
    return client;
  }
  try {
    await mkdir(join(directory, 'db'), { mode: 0o700 });
    server = await privateMongo(directory, { net: { bindIp: socket, port: 0 }, localhostBypass: true });
    assert.ok(server.process.pid);
    await waitFor(() => assertOwnedUnixSocket(socket, server.process.pid, 0o700));
    const unauthorized = (error) => error.code === 13;
    await assert.rejects(provisionMongoIdentity(socket, credentials, temporaryPassword, true, async () => {
      throw new Error('test interruption at the authenticated administrator checkpoint');
    }), /test interruption/u);
    const administrator = connect(encodeURIComponent(socket), 'admin', 'planner-bootstrap', temporaryPassword);
    await administrator.db(databaseName).command({
      createUser: appUsername, pwd: credentials.password,
      customData: { installationId: credentials.installationId },
      roles: [{ role: 'readWrite', db: databaseName }, { role: 'read', db: 'unrelated' }],
    });
    await assert.rejects(provisionMongoIdentity(socket, credentials, temporaryPassword, false, async () => {}),
      /unexpected role or installation claim/u);
    const excessiveApp = connect(encodeURIComponent(socket), databaseName, appUsername, credentials.password);
    assert.equal(await excessiveApp.db(databaseName).collection('installation').findOne({}), null);
    await excessiveApp.close();
    await administrator.db(databaseName).command({ dropUser: appUsername });
    await administrator.close();
    await provisionMongoIdentity(socket, credentials, temporaryPassword, false, async () => {});
    await provisionMongoIdentity(socket, credentials, temporaryPassword, false, async () => {
      assert.fail('A retired administrator must remain retired');
    });

    let foreignConnections = 0;
    const sameUidListener = createServer((connection) => { foreignConnections += 1; connection.destroy(); });
    await new Promise((resolve) => sameUidListener.listen(port, '127.0.0.1', resolve));
    try {
      await assert.rejects(assertOwnedTcpPort(port, server.process.pid, credentials.dbUid), /spawned MongoDB must own/u);
      assert.equal(foreignConnections, 0);
    } finally {
      await new Promise((resolve) => sameUidListener.close(resolve));
    }

    await server.stop();
    server = await privateMongo(directory, {
      net: { bindIp: `127.0.0.1,${permanentSocket}`, port }, localhostBypass: false,
    });
    await waitFor(() => assertOwnedTcpPort(port, server.process.pid, credentials.dbUid));
    await waitFor(() => assertOwnedUnixSocket(permanentSocket, server.process.pid, 0o777));
    const endpoint = encodeURIComponent(permanentSocket);
    const app = connect(endpoint, databaseName, appUsername, credentials.password);
    const anonymous = connect(endpoint);
    await assertMongoIdentity(app, credentials.installationId);
    await assert.rejects(assertMongoIdentity(app, randomUUID()), /unexpected role or installation claim/u);
    await assert.rejects(connect(endpoint, 'admin', 'planner-bootstrap', temporaryPassword).connect(), { code: 18 });
    await assert.rejects(anonymous.db(databaseName).collection('installation').findOne({}), unauthorized);
    await assert.rejects(app.db('unrelated').collection('documents').findOne({}), unauthorized);
    await assert.rejects(app.db('admin').command({
      createUser: 'forbidden', pwd: randomBytes(32).toString('hex'), roles: ['root'],
    }), unauthorized);

    const installation = app.db(databaseName).collection('installation');
    const unexpectedId = randomUUID();
    await installation.updateOne({ _id: 'installation' }, { $set: { installationId: unexpectedId } });
    await assert.rejects(assertMongoIdentity(app, credentials.installationId), /UUID does not match/u);
    assert.equal((await installation.findOne({ _id: 'installation' })).installationId, unexpectedId);
    const log = await readFile(join(directory, 'mongod.log'), 'utf8');
    assert.equal(log.includes(credentials.password) || log.includes(temporaryPassword), false);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('listener ownership check does not connect to a foreign server', async () => {
  let connections = 0;
  const sentinel = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(assertLoopbackListener(sentinel.address().port, process.getuid() + 1), /unexpected ownership/u);
    assert.equal(connections, 0);
    assert.equal(sentinel.listening, true);
  } finally {
    await new Promise((resolve) => sentinel.close(resolve));
  }
});
