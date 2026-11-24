import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [, , mode, executablePath] = process.argv;
const projectId = 'c0d7680f-1a44-4222-8b16-22c35e1be317';
const boardId = 'c0d7680f-1a44-4222-8b16-22c35e1be318';
const base = 'https://planner.example.test';
const run = promisify(execFile);

async function seed() {
  const dist = (path) => import(pathToFileURL('/opt/planner/current/apps/backend/dist/' + path));
  const { connectConfiguredNativeMongo } = await dist('native/mongo-readiness.js');
  const { parseMongoCredentials, databaseName } = await dist('native/mongo-identity.js');
  const { readFile } = await import('node:fs/promises');
  const { openActiveWorkspace } = await dist('storage/scoped.js');
  const { createNativeCommandGate } = await dist('native/writer.js');
  const { CommandJournal } = await dist('application/command-journal/journal.js');
  const { installationId } = parseMongoCredentials(JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8')));
  const client = await connectConfiguredNativeMongo();
  const gate = createNativeCommandGate();
  try {
    const db = client.db(databaseName);
    const workspace = await openActiveWorkspace(db, installationId);
    const actor = await db.collection('users').findOne({ generationId: workspace.generationId, normalizedEmail: 'admin@example.test' });
    assert.ok(actor);
    await new CommandJournal(gate, db, installationId).recover();
    const createdAt = new Date();
    await gate.runCommand(async () => {
      await workspace.insert('projects', projectId, { name: 'Board event fixture', type: 'shared', hidden: false,
        ownerProjectManagerId: null, rank: '1024', createdAt });
      await workspace.insert('projectManagers', randomUUID(), { projectId, userId: actor.id, createdAt }, 1);
      await workspace.insert('boards', boardId, { projectId, name: 'Event board', rank: '1024', createdAt });
      await workspace.insert('boardMembers', randomUUID(), { boardId, userId: actor.id, role: 'viewer', canComment: false, createdAt }, 1);
    });
  } finally { await gate.closeAndDrain(); await client.close(); }
}

async function browser() {
  const { chromium } = await import('./playwright-core/index.mjs');
  const chrome = await chromium.launch({ executablePath, args: [
    '--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP planner.example.test 127.0.0.1',
  ] });
  try {
    const context = await chrome.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const path = '/api/v1/boards/' + boardId;
    async function readiness(expected) {
      for (let tries = 0; tries < 100; tries++) {
        const status = await page.evaluate(async () => (await fetch('/health/ready')).status).catch(() => 0);
        if (status === expected) return;
        await pause(200);
      }
      assert.fail('Planner did not reach expected readiness.');
    }
    const wait = async (count) => page.waitForFunction((count) => window.receivedEvents.length >= count, count, { timeout: 12_000 });
    const closed = async () => page.waitForFunction(() => window.eventSourceClosed, undefined, { timeout: 12_000 });
    const subscribe = async (after) => page.evaluate(({ path, after }) => new Promise((resolve, reject) => {
      const source = new EventSource(path + '/events' + (after ? '?after=' + encodeURIComponent(after) : ''));
      window.activeStream = source;
      window.receivedEvents = [];
      window.readyCursor = null;
      window.eventSourceClosed = false;
      source.onopen = () => resolve();
      source.onerror = () => {
        source.close();
        window.eventSourceClosed = true;
        reject(new Error('Board stream did not open.'));
      };
      source.addEventListener('ready', (event) => { window.readyCursor = event.lastEventId; });
      source.addEventListener('board.access-changed', (event) => {
        window.receivedEvents.push({ cursor: event.lastEventId, data: JSON.parse(event.data), state: source.readyState });
      });
    }), { path, after });

    // Establish the login through the packaged TLS proxy, then let Chromium use its own same-origin cookie.
    await page.goto(base + '/sign-in', { waitUntil: 'domcontentloaded' });
    await readiness(200);
    const session = await page.evaluate(async () => {
      const response = await fetch('/api/v1/session/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'admin@example.test', password: 'Synthetic test password number 42' }),
      });
      if (!response.ok) throw new Error('The guest account could not sign in.');
      return response.json();
    });
    const initial = await page.evaluate(async (path) => (await (await fetch(path + '/workspace')).json()).data, path);
    assert.equal(initial.latestEventSequence, '0');
    await subscribe();
    await page.waitForFunction(() => window.readyCursor !== null);
    const readyCursor = await page.evaluate(() => window.readyCursor);
    assert.equal(readyCursor, initial.eventCursor);
    await page.evaluate(() => window.activeStream.close());
    async function change(canComment, revision) {
      const response = await page.evaluate(async ({ path, id, revision, csrf, key, canComment }) => {
        const result = await fetch(path + '/members/' + id, { method: 'PATCH', headers: {
          'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'If-Match': '"' + revision + '"', 'Idempotency-Key': key,
        }, body: JSON.stringify({ canComment }) });
        return result.status;
      }, { path, id: session.account.id, revision, csrf: session.csrfToken, key: randomUUID(), canComment });
      assert.equal(response, 200);
    }
    await change(true, 1);
    await subscribe(readyCursor);
    await wait(1);
    const first = await page.evaluate(() => window.receivedEvents[0]);
    assert.deepEqual(first.data, { boardId });
    assert.equal(first.state, 1);
    await change(false, 2);
    await wait(2);
    const ordered = await page.evaluate(() => window.receivedEvents);
    assert.equal(ordered.length, 2);
    assert.notEqual(ordered[0].cursor, ordered[1].cursor);
    assert.ok(ordered.every(({ state }) => state === 1));

    await run('systemctl', ['stop', 'planner-mongodb.service']);
    assert.equal(await page.evaluate(async () => (await fetch('/health/live')).status), 200);
    await readiness(503);
    await closed();
    await run('systemctl', ['start', 'planner-mongodb.service']);
    await readiness(200);
    await subscribe(readyCursor);
    await wait(2);
    assert.deepEqual(await page.evaluate(() => window.receivedEvents), ordered);
    await page.evaluate(() => window.activeStream.close());
    await run('systemctl', ['restart', 'planner.service']);
    await readiness(200);
    await subscribe(initial.eventCursor);
    await wait(2);
    assert.deepEqual(await page.evaluate(() => window.receivedEvents), ordered);
    const logout = await page.evaluate(async (csrf) => (await fetch('/api/v1/session', { method: 'DELETE', headers: {
      'X-CSRF-Token': csrf,
    } })).status, session.csrfToken);
    assert.equal(logout, 204);
    await closed();
    assert.equal(await page.evaluate(async (path) => (await fetch(path + '/events')).status, path), 401);
    console.log('Chromium received ordered committed frames through native nginx before EOF, replayed after restart, and stopped on logout.');
  } finally { await chrome.close(); }
}

if (mode === 'seed') await seed();
else if (mode === 'browser' && executablePath) await browser();
else throw new Error('Choose seed or browser for the native board event fixture.');
