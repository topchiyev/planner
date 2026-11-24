import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceFixture, workspaceIds } from '../fixtures/planner-workspace.ts';
import { mongoFixtureDirectoryPrefix, withFixtureMongo } from '../support/fixture-mongo.ts';

async function checkPrivateSocket({ directory, socketPath, pid }) {
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(directory, 'db'))).mode & 0o777, 0o700);
  assert.ok((await lstat(socketPath)).isSocket());

  const descriptors = `/proc/${pid}/fd`;
  const links = await Promise.all((await readdir(descriptors)).map(async (fd) => {
    try {
      return await readlink(join(descriptors, fd));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }
  }));
  const socketInodes = new Set(links.map((link) => /^socket:\[(\d+)\]$/u.exec(link)?.[1]).filter(Boolean));
  assert.ok(socketInodes.size > 0);
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = (await readFile(table, 'utf8')).trim().split('\n').slice(1);
    assert.ok(rows.every((row) => !socketInodes.has(row.trim().split(/\s+/u)[9])), 'fixture owns no TCP sockets');
  }
}

async function checkRemoved(fixture) {
  assert.throws(() => process.kill(fixture.pid, 0), { code: 'ESRCH' });
  await assert.rejects(() => lstat(fixture.directory), { code: 'ENOENT' });
}

test('two authenticated standalone fixtures overlap without sharing workspace data', { timeout: 40_000 }, async () => {
  const cleaned = [];
  await withFixtureMongo(async (first) => {
    await withFixtureMongo(async (second) => {
      cleaned.push(first, second);
      assert.notEqual(first.pid, second.pid);
      assert.notEqual(first.directory, second.directory);
      assert.notEqual(first.socketPath, second.socketPath);
      await Promise.all([checkPrivateSocket(first), checkPrivateSocket(second)]);
      const workspace = createWorkspaceFixture();
      const scenarios = [[first, 'private-socket-a'], [second, 'private-socket-b']];
      await Promise.all(scenarios.map(async ([fixture, marker]) => {
        const users = fixture.db.collection('users');
        await users.insertMany(workspace.users.map((user) => ({ ...user, marker })));
        assert.equal(await users.countDocuments({ generationId: workspaceIds.generation }), workspace.users.length);
        const actor = await users.findOne({ id: workspaceIds.secondEditor });
        assert.equal(actor.marker, marker);
        assert.equal(actor.username, null);
        assert.equal(await fixture.db.collection('users').countDocuments({ marker: { $ne: marker } }), 0);
        await assert.rejects(() => fixture.anonymousDb.collection('users').findOne({}), { code: 13 });
        await assert.rejects(() => fixture.client.db('outside_fixture').collection('users').findOne({}), { code: 13 });
      }));
    });
  });
  await Promise.all(cleaned.map(checkRemoved));
});

test('an exception in a fixture test reaps its child and removes its data', { timeout: 25_000 }, async () => {
  const failure = new Error('injected fixture callback failure');
  let captured;
  await assert.rejects(() => withFixtureMongo(async (fixture) => {
    captured = fixture;
    throw failure;
  }), (error) => error === failure);
  await checkRemoved(captured);
});

test('a failed mongod startup removes the private bootstrap directory', { timeout: 15_000 }, async (t) => {
  const bin = await mkdtemp('/tmp/planner-mongo-test-bin-');
  t.after(() => rm(bin, { recursive: true, force: true }));
  const marker = join(bin, 'bootstrap-cwd');
  await writeFile(join(bin, 'mongod'), `#!/bin/sh\nprintf '%s' "$PWD" > '${marker}'\nexit 9\n`, { mode: 0o700 });
  const tester = `
    import { withFixtureMongo } from './tests/support/fixture-mongo.ts';
    try { await withFixtureMongo(async () => process.exit(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', tester], {
    env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not start the isolated MongoDB fixture/u);
  const directory = await readFile(marker, 'utf8');
  assert.ok(directory.startsWith(mongoFixtureDirectoryPrefix));
  await assert.rejects(() => lstat(directory), { code: 'ENOENT' });
});

test('an external TCP canary receives no connection when preflight rejects a supplied URI', { timeout: 15_000 }, async (t) => {
  let accepted = 0;
  const canary = createServer((socket) => {
    accepted++;
    socket.destroy();
  });
  const listening = once(canary, 'listening');
  canary.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => canary.close(resolve)));
  await listening;

  const secret = 'fixture-only-credential-sentinel';
  const target = `mongodb://test:${secret}@127.0.0.1:${canary.address().port}/outside`;
  const bin = await mkdtemp('/tmp/planner-mongo-test-bin-');
  t.after(() => rm(bin, { recursive: true, force: true }));
  const marker = join(bin, 'child-started');
  for (const command of ['npm', 'mongod']) {
    await writeFile(join(bin, command), `#!/bin/sh\n: > '${marker}'\nexit 9\n`, { mode: 0o700 });
  }
  const result = spawnSync(process.execPath, ['tests/run-integration.ts'], {
    env: { ...process.env, PATH: bin, PLANNER_MONGO_URI: target }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only uses its own MongoDB fixture/u);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, 'refusal omits credential values');
  await assert.rejects(() => lstat(marker), { code: 'ENOENT' });
  await delay(50);
  assert.equal(accepted, 0);
});
