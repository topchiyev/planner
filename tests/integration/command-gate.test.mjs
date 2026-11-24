import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MongoWriteConcernError } from 'mongodb';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { withFixtureMongo } from '../support/fixture-mongo.ts';

assertOwnedMongoEnvironment(process.env);
const { CommandGate, GateUnavailableError, CleanCommandRejection } = await import('../../apps/backend/dist/application/command-gate/gate.js');
const { acquireWriterDirectory, WriterOwnershipError } = await import('../../apps/backend/dist/application/command-gate/writer-lease.js');
const { createWorkspaceAccess } = await import('../../apps/backend/dist/application/command-gate/workspace-access.js');
const { migrateStorageSchema } = await import('../../apps/backend/dist/storage/schema.js');
const { openActiveWorkspace, openTrustedStagedWorkspace } = await import('../../apps/backend/dist/storage/scoped.js');
const { buildApp } = await import('../../apps/backend/dist/build-app.js');
const owner = { uid: process.getuid(), gid: process.getgid() };
const processScript = fileURLToPath(new URL('../support/writer-process.mjs', import.meta.url));

async function scratch(t) {
  const parent = await mkdtemp(join(tmpdir(), 'planner-writer-'));
  const directory = join(parent, 'planner');
  await mkdir(directory, { mode: 0o750 });
  await chmod(directory, 0o750);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, directory };
}

function startWriter(role, directory, effects) {
  const child = fork(processScript, [role, directory, effects], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'close');
  const reported = Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(([status, signal]) => { throw new Error(`Writer exited before its report (${status}, ${signal}).`); }),
  ]);
  return { child, exited, reported };
}

function deferred() { return Promise.withResolvers(); }

test('app and maintenance contend on the same inode and neither graceful exit nor SIGKILL leaves a lock', { timeout: 15_000 }, async (t) => {
  const { parent, directory } = await scratch(t);
  const effects = join(parent, 'effects');
  await writeFile(effects, '');
  const original = await lstat(directory);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const running = startWriter('app', directory, effects);
    let workerPid;
    try {
      const report = await running.reported;
      assert.equal(report.status, 'acquired');
      workerPid = report.workerPid;
      assert.ok(workerPid > 0);
      const workerFds = `/proc/${workerPid}/fd`;
      const readers = await Promise.all((await readdir(workerFds)).map((fd) => readlink(join(workerFds, fd)).catch(() => undefined)));
      assert.equal(readers.includes(directory), false);
      const before = await readFile(effects, 'utf8');
      const contender = startWriter('maintenance', directory, effects);
      assert.deepEqual(await contender.reported, { status: 'refused' });
      assert.deepEqual(await contender.exited, [75, null]);
      assert.equal(await readFile(effects, 'utf8'), before);
      assert.deepEqual(await readdir(directory), []);
      running.child.kill(signal);
      assert.deepEqual(await running.exited, signal === 'SIGTERM' ? [0, null] : [null, 'SIGKILL']);
      if (signal === 'SIGKILL') process.kill(workerPid, 0);
      const next = startWriter('maintenance', directory, effects);
      assert.deepEqual(await next.reported, { status: 'acquired' });
      assert.deepEqual(await next.exited, [0, null]);
      const after = await lstat(directory);
      assert.deepEqual([after.dev, after.ino], [original.dev, original.ino]);
    } finally {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL');
      await running.exited;
      if (workerPid && signal === 'SIGKILL') {
        try { process.kill(workerPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
  assert.equal(await readFile(effects, 'utf8'), 'app\nmaintenance\napp\nmaintenance\n');
  const alias = join(parent, 'alias');
  await symlink(directory, alias);
  assert.throws(() => acquireWriterDirectory(alias, owner, owner), WriterOwnershipError);
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
});

test('owned Mongo snapshots straddle the full commit and waiting writers outrank later readers', { timeout: 20_000 }, async (t) => {
  const { directory } = await scratch(t);
  const gate = new CommandGate(acquireWriterDirectory(directory, owner, owner));
  t.after(() => gate.closeAndDrain());
  return withFixtureMongo(async ({ db }) => {
    const items = db.collection('gateFixture');
    await items.insertMany([{ _id: 'left', revision: 1 }, { _id: 'right', revision: 1 }]);
    await assert.rejects(gate.readSnapshot(() => items.findOne({})), GateUnavailableError);
    await gate.recover(async () => assert.equal(await items.countDocuments({ revision: 1 }), 2));
    const stages = [deferred(), deferred()];
    const finish = [deferred(), deferred()];
    const readPair = async (position) => {
      const first = await items.findOne({ _id: 'left' });
      if (position !== undefined) {
        stages[position].resolve();
        await finish[position].promise;
      }
      const second = await items.findOne({ _id: 'right' });
      return [first.revision, second.revision];
    };
    const readers = stages.map((_stage, position) => gate.readSnapshot(() => readPair(position)));
    await Promise.all(stages.map((stage) => stage.promise));
    const firstWrite = deferred();
    const secondWrite = deferred();
    const effectsApplied = deferred();
    const commit = deferred();
    const disconnect = deferred();
    let writerStarted = false;
    let laterStarted = false;
    const writer = gate.runCommand(async () => {
      writerStarted = true;
      await items.updateOne({ _id: 'left' }, { $set: { revision: 2 } });
      firstWrite.resolve();
      await secondWrite.promise;
      await items.updateOne({ _id: 'right' }, { $set: { revision: 2 } });
      effectsApplied.resolve();
      await commit.promise;
    });
    const request = Promise.race([writer, disconnect.promise]);
    const later = gate.readSnapshot(() => { laterStarted = true; return readPair(); });
    try {
      finish[0].resolve();
      assert.deepEqual(await readers[0], [1, 1]);
      assert.equal(writerStarted || laterStarted, false);
      finish[1].resolve();
      assert.deepEqual(await readers[1], [1, 1]);
      await firstWrite.promise;
      disconnect.resolve('connection closed');
      assert.equal(await request, 'connection closed');
      assert.deepEqual(await readPair(), [2, 1]);
      assert.equal(laterStarted, false);
      secondWrite.resolve();
      await effectsApplied.promise;
      assert.equal(laterStarted, false);
      commit.resolve();
      await writer;
      assert.deepEqual(await later, [2, 2]);
    } finally {
      for (const barrier of [...finish, secondWrite, commit]) barrier.resolve();
      await Promise.allSettled([...readers, writer, later]);
    }
  });
});

test('active workspace materialization and generation changes share one gate', { timeout: 30_000 }, async (t) => {
  const { directory } = await scratch(t);
  const gate = new CommandGate(acquireWriterDirectory(directory, owner, owner));
  t.after(() => gate.closeAndDrain());
  return withFixtureMongo(async ({ db }) => {
    const [installationId, previousId, stagedId, projectId] = Array.from({ length: 4 }, () => randomUUID());
    const installations = db.collection('installation');
    await gate.recover(async () => {
      await installations.insertOne({ _id: 'installation', installationId, activeGenerationId: previousId, schemaVersion: 0 });
      await migrateStorageSchema(db, installationId);
      const active = await openActiveWorkspace(db, installationId);
      const staged = await openTrustedStagedWorkspace(db, installationId, stagedId);
      await active.insert('projects', projectId, { name: 'previous' });
      await staged.insert('projects', projectId, { name: 'next' });
    });

    const bindingChecked = deferred();
    const materialize = deferred();
    let pause = true;
    let injectedInsertError;
    const collection = db.collection.bind(db);
    const observedDatabase = new Proxy(db, { get(target, key) {
      if (key === 'collection') return (name, ...options) => {
        const source = collection(name, ...options);
        if (name === 'projects') {
          if (injectedInsertError) source.insertOne = async () => { throw injectedInsertError; };
          const findOne = source.findOne.bind(source);
          source.findOne = async (...query) => {
            if (pause) {
              pause = false;
              // The real storage handle calls findOne after checking the active binding.
              bindingChecked.resolve();
              await materialize.promise;
            }
            return findOne(...query);
          };
        }
        return source;
      };
      const property = Reflect.get(target, key, target);
      return typeof property === 'function' ? property.bind(target) : property;
    } });
    const workspace = createWorkspaceAccess(gate, observedDatabase, installationId);
    let escaped;
    const snapshot = workspace.readSnapshot(async (view) => {
      assert.equal(view.insert, undefined);
      escaped = view;
      return view.read('projects', projectId);
    });
    await Promise.race([bindingChecked.promise, snapshot]);
    const change = gate.runCommand(async () => {
      const result = await installations.updateOne({ _id: 'installation', activeGenerationId: previousId },
        { $set: { activeGenerationId: stagedId } });
      assert.equal(result.modifiedCount, 1);
    });
    const later = workspace.readSnapshot((view) => view.read('projects', projectId));
    try {
      assert.equal((await installations.findOne({ _id: 'installation' })).activeGenerationId, previousId);
      materialize.resolve();
      assert.equal((await snapshot).name, 'previous');
      await change;
      assert.equal((await later).name, 'next');
      await assert.rejects(escaped.read('projects', projectId), GateUnavailableError);

      const clean = new CleanCommandRejection('stale fixture revision');
      await assert.rejects(workspace.runCommand(async (view) => {
        try { await view.insert('projects', projectId, { name: 'duplicate' }); }
        catch (error) {
          assert.equal(error.code, 11_000);
          throw clean;
        }
      }), clean);
      assert.equal(gate.ready, true);
      await assert.rejects(workspace.runCommand(async (view) => {
        assert.equal(await view.update('projects', projectId, { name: 'rejected' }, 99), false);
        throw clean;
      }), clean);
      assert.equal(gate.ready, true);
      await assert.rejects(workspace.runCommand(async (view) => {
        assert.equal(await view.update('projects', projectId, { name: 'applied' }, 1), true);
        try { await view.insert('projects', projectId, { name: 'duplicate after success' }); }
        catch { throw clean; }
      }), /applied effects before it failed/u);
      assert.equal(gate.state, 'maintenance');
      await assert.rejects(workspace.readSnapshot((view) => view.read('projects', projectId)), GateUnavailableError);

      await gate.recover(() => {});
      injectedInsertError = new MongoWriteConcernError({ code: 11_000,
        writeConcernError: { code: 64, errmsg: 'fixture write concern was unconfirmed' } });
      await assert.rejects(workspace.runCommand(async (view) => {
        try { await view.insert('projects', projectId, { name: 'unknown' }); }
        catch { throw clean; }
      }), injectedInsertError);
      assert.equal(gate.state, 'maintenance');
    } finally {
      materialize.resolve();
      await Promise.allSettled([snapshot, change, later]);
    }
  });
});

test('uncertain operations fail maintenance, clean rejections preserve order, and draining retains ownership', async (t) => {
  const { directory } = await scratch(t);
  const lease = acquireWriterDirectory(directory, owner, owner);
  const gate = new CommandGate(lease);
  lease.release();
  assert.throws(() => acquireWriterDirectory(directory, owner, owner), /already owns/u);
  const app = buildApp({ native: { origin: 'https://planner.example.test', readAccess: async () => gate.ready
    ? { kind: 'ready' } : { kind: 'unavailable', reason: 'schema-or-recovery' } } });
  t.after(async () => { await app.close(); await gate.closeAndDrain(); });
  const status = () => app.inject('/health/ready');
  const uncertain = new Error('test storage uncertainty');
  assert.equal((await status()).statusCode, 503);
  await assert.rejects(gate.recover(async () => { throw uncertain; }), uncertain);
  assert.equal(gate.state, 'maintenance');
  await gate.recover(() => {});
  assert.equal((await status()).statusCode, 200);
  const clean = new CleanCommandRejection('fixture validation denied');
  const validation = deferred();
  const order = [];
  const validationDenied = assert.rejects(gate.runCommand(async () => {
    order.push('validation');
    await validation.promise;
    throw clean;
  }), clean);
  const nextCommand = gate.runCommand(() => order.push('next command'));
  const nextRead = gate.readSnapshot(() => order.push('next read'));
  validation.resolve();
  await Promise.all([validationDenied, nextCommand, nextRead]);
  assert.deepEqual(order, ['validation', 'next command', 'next read']);
  assert.equal(gate.state, 'open');

  const failure = deferred();
  const write = gate.runCommand(() => failure.promise);
  let leaked = false;
  const queued = gate.readSnapshot(() => { leaked = true; });
  const denied = assert.rejects(queued, GateUnavailableError);
  const rejected = assert.rejects(write, uncertain);
  failure.reject(uncertain);
  await Promise.all([rejected, denied]);
  assert.equal(leaked, false);
  assert.equal(gate.state, 'maintenance');
  const unavailable = await status();
  assert.equal(unavailable.statusCode, 503);
  assert.doesNotMatch(unavailable.body, /test storage uncertainty/u);
  await gate.recover(() => {});
  assert.equal((await status()).statusCode, 200);

  const active = deferred();
  const draining = gate.runCommand(() => active.promise);
  const discarded = assert.rejects(gate.runCommand(() => { leaked = true; }), GateUnavailableError);
  const closed = gate.closeAndDrain();
  try {
    assert.equal(gate.state, 'closing');
    assert.throws(() => acquireWriterDirectory(directory, owner, owner), /already owns/u);
    assert.equal((await status()).statusCode, 503);
  } finally { active.resolve(); }
  await Promise.all([draining, discarded, closed]);
  assert.equal(leaked, false);
  assert.equal(gate.state, 'closed');
  acquireWriterDirectory(directory, owner, owner).release();
});

test('maintenance rejects a racing snapshot and holds the lease through an interrupted recovery', async (t) => {
  const { directory } = await scratch(t);
  const gate = new CommandGate(acquireWriterDirectory(directory, owner, owner));
  t.after(() => gate.closeAndDrain());
  await gate.recover(() => {});
  const first = deferred();
  const second = deferred();
  const uncertain = new Error('test failed snapshot');
  const failed = assert.rejects(gate.readSnapshot(() => first.promise), uncertain);
  const concurrent = assert.rejects(gate.readSnapshot(() => second.promise), GateUnavailableError);
  try {
    first.reject(uncertain);
    await failed;
    assert.equal(gate.state, 'maintenance');
    await assert.rejects(gate.recover(() => assert.fail('Recovery must wait for active snapshots')), GateUnavailableError);
  } finally { second.resolve('materialized before recovery'); }
  await concurrent;
  const repair = deferred();
  const recovering = gate.recover(() => repair.promise);
  assert.equal(gate.state, 'recovering');
  const closing = gate.closeAndDrain();
  try {
    assert.equal(gate.state, 'closing');
    assert.throws(() => acquireWriterDirectory(directory, owner, owner), /already owns/u);
  } finally { repair.resolve(); }
  await Promise.all([recovering, closing]);
  assert.equal(gate.state, 'closed');
  acquireWriterDirectory(directory, owner, owner).release();
});

test('uncertainty invalidates an in-flight snapshot before and during shutdown', async (t) => {
  const { directory } = await scratch(t);
  for (const timing of ['before', 'during']) {
    const gate = new CommandGate(acquireWriterDirectory(directory, owner, owner));
    await gate.recover(() => {});
    const first = deferred();
    const second = deferred();
    const uncertain = new Error('test failed snapshot during drain');
    const failed = assert.rejects(gate.readSnapshot(() => first.promise), uncertain);
    const concurrent = assert.rejects(gate.readSnapshot(() => second.promise), GateUnavailableError);
    let closing;
    try {
      if (timing === 'during') closing = gate.closeAndDrain();
      first.reject(uncertain);
      await failed;
      closing ??= gate.closeAndDrain();
      assert.throws(() => acquireWriterDirectory(directory, owner, owner), /already owns/u);
      second.resolve('must not leave the invalidated snapshot');
      await Promise.all([concurrent, closing]);
      assert.equal(gate.state, 'closed');
    } finally {
      first.reject(uncertain);
      second.resolve();
      await Promise.allSettled([failed, concurrent, gate.closeAndDrain()]);
    }
  }
});
