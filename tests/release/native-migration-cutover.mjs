import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectVerifiedNativeMongo } from '/opt/planner/current/apps/backend/dist/native/mongo-readiness.js';
import { acquireNativeWriter } from '/opt/planner/current/apps/backend/dist/native/writer.js';
import { legacyPublicId } from '/opt/planner/current/apps/backend/dist/storage/identity.js';
import { createPasswordHasher } from '/opt/planner/current/apps/backend/dist/application/auth/password.js';
import { CommandGate } from '/opt/planner/current/apps/backend/dist/application/command-gate/gate.js';
import { CommandJournal } from '/opt/planner/current/apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '/opt/planner/current/apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '/opt/planner/current/apps/backend/dist/application/workspace/relationship-commands.js';

const args = process.argv.slice(2);
assert.equal(process.getuid(), 0);
const credential = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const client = await connectVerifiedNativeMongo(credential);
const db = client.db('planner');
const { installationId } = credential;

async function commandChild() {
  const [{ checkpoint, token, cardId, ownerId, key, revision, name }] = await once(process, 'message');
  const gate = new CommandGate(acquireNativeWriter());
  try {
    const journal = new CommandJournal(gate, db, installationId, {
      operations: createRelationshipJournalOperations(db, () => resolveBrowserWorkspace(db, installationId, token, new Date()), 'web', key),
      async checkpoint(point) {
        if (point !== checkpoint) return;
        await new Promise((resolve) => process.send(point, resolve));
        await new Promise(() => {});
      },
    });
    await journal.recover();
    await journal.execute({ actorId: ownerId, operationId: 'cards.update', idempotencyKey: key,
      input: { id: cardId, expectedRevision: revision, name } });
    throw new Error('The requested crash checkpoint was never reached.');
  } finally { await gate.closeAndDrain(); }
}

function operator(action, ...options) {
  const output = execFileSync('/usr/bin/plannerctl', ['migration', action, ...options, '--format', 'json'], { encoding: 'utf8' });
  return JSON.parse(output);
}

function refuses(fault, action, ...options) {
  const result = spawnSync('/usr/bin/plannerctl', ['migration', action, ...options, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).fault, fault);
}

function app(action) { execFileSync('/usr/bin/systemctl', [action, 'planner.service']); }

async function killAt(options) {
  const child = fork(fileURLToPath(import.meta.url), ['command-child'], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  const reached = once(child, 'message').then(([point]) => point);
  try {
    child.send(options);
    const actual = await Promise.race([reached, exited, once(AbortSignal.timeout(20_000), 'abort')]);
    assert.equal(actual, options.checkpoint);
  } finally { child.kill('SIGKILL'); }
  assert.deepEqual(await exited, [null, 'SIGKILL']);
}

async function qualify() {
  const [runId, cert, codePath, mode] = args;
  assert.ok(['rollback', 'writable'].includes(mode));
  const ca = await readFile(cert);
  const origin = 'https://planner.example.test';
  function api(path, { method = 'GET', body, session, headers } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body);
      const outgoing = request({ hostname: '127.0.0.1', servername: 'planner.example.test', ca, path, method,
        headers: { Host: 'planner.example.test', Origin: origin,
          ...(encoded !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
          ...(session && { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }), ...headers },
      }, (incoming) => {
        const parts = [];
        incoming.on('data', (part) => parts.push(part));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const bytes = Buffer.concat(parts);
          const json = (incoming.headers['content-type'] ?? '').includes('application/json') ? JSON.parse(bytes.toString()) : null;
          resolve({ status: incoming.statusCode, json, bytes, cookie: incoming.headers['set-cookie']?.[0]?.split(';')[0] });
        });
      });
      outgoing.setTimeout(5000, () => outgoing.destroy());
      outgoing.on('error', reject).end(encoded);
    });
  }
  async function ready(status) {
    for (let count = 0; count < 160; count++) {
      const response = await api('/health/ready').catch(() => undefined);
      if (response?.status === status) return;
      await delay(100);
    }
    assert.fail(`Workspace readiness did not reach ${status}.`);
  }
  async function signIn(identifier, password, code) {
    let result = await api('/api/v1/session/login', { method: 'POST', body: { identifier, password } });
    assert.equal(result.status, 200);
    if (code) {
      assert.equal(result.json.status, 'challenge-required');
      result = await api('/api/v1/session/verify-mfa', { method: 'POST',
        body: { challengeId: result.json.challengeId, recoveryCode: code } });
    }
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'authenticated');
    assert.ok(result.cookie);
    return { cookie: result.cookie, csrfToken: result.json.csrfToken, actor: result.json.account.id };
  }
  const run = await db.collection('importRuns').findOne({ installationId, id: runId });
  assert.equal(run.state, 'verified');
  const { generationId, manifestSha256 } = run;
  const id = (table, source) => legacyPublicId(run.source.instanceId, table, source);
  const ownerId = id('user_account', '102');
  const secondPassword = 'Synthetic retained Planner credential';
  const seed = acquireNativeWriter();
  try {
    // The guest has two synthetic users to check ordinary ACL and media reads after cutover.
    const passwordVerifier = await createPasswordHasher().encode(secondPassword);
    const updated = await db.collection('users').updateOne({ generationId, id: ownerId, requiresMfaEnrollment: false }, {
      $set: { localAuth: { passwordVerifier, credentialsVersion: 2, mfa: 'none' } }, $inc: { revision: 1 },
    }, { writeConcern: { w: 1, j: true } });
    assert.equal(updated.matchedCount, 1);
  } finally { seed.release(); }
  app('start');
  await ready(503);
  refuses('approval-invalid', 'activate', '--run', runId, '--expect-manifest', '0'.repeat(64));
  const activated = operator('activate', '--run', runId, '--expect-manifest', manifestSha256);
  assert.equal(activated.state, 'activeReadOnly');
  assert.deepEqual(operator('activate', '--run', runId, '--expect-manifest', manifestSha256), activated);
  assert.equal(operator('status', '--run', runId).state, 'activeReadOnly');
  await ready(200);
  const admin = await signIn('iris@planner-fixture.invalid', '  Owned äccount 🗝️ pass & %  ', (await readFile(codePath, 'utf8')).trim());
  const owner = await signIn('rowan@planner-fixture.invalid', secondPassword);
  assert.equal(admin.actor, id('user_account', '101'));
  assert.equal(owner.actor, ownerId);
  const privateBoard = `/api/v1/boards/${id('board', '302')}`;
  assert.equal((await api(privateBoard, { session: admin })).status, 404);
  assert.equal((await api(privateBoard, { session: owner })).status, 200);
  const imageId = id('attachment', '601');
  const media = await api(`/api/v1/attachments/${imageId}/download`, { session: admin });
  assert.equal(media.status, 200);
  const reference = await db.collection('attachments').findOne({ generationId, id: imageId });
  assert.equal(createHash('sha256').update(media.bytes).digest('hex'), reference.blobDigest);
  const cardId = id('card', '9007199254740993');
  const cardPath = `/api/v1/cards/${cardId}`;
  const revision = (await api(cardPath, { session: owner })).json.data.revision;
  const name = 'Synthetic post-cutover edit';
  const key = randomUUID();
  const change = () => api(cardPath, { method: 'PATCH', session: owner, body: { name },
    headers: { 'If-Match': `"${revision}"`, 'Idempotency-Key': key } });
  const forbidden = await change();
  assert.equal(forbidden.status, 409);
  assert.equal(forbidden.json.error.code, 'WORKSPACE_READ_ONLY');
  assert.equal((await api(`/api/v1/cards/${cardId}/notifications/read`, { method: 'POST', session: owner, body: {},
    headers: { 'Idempotency-Key': randomUUID() } })).json.error.code, 'WORKSPACE_READ_ONLY');
  const stagedBefore = await readdir('/var/lib/planner/staging');
  const boundary = 'synthetic-migration-drill';
  const form = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.txt"\r\n`
    + `Content-Type: text/plain\r\n\r\nsynthetic\r\n--${boundary}--\r\n`);
  const upload = await api(`${cardPath}/attachment-files`, { method: 'POST', session: owner, body: form,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'If-Match': `"${revision}"`, 'Idempotency-Key': randomUUID() } });
  assert.equal(upload.status, 409);
  assert.equal(upload.json.error.code, 'WORKSPACE_READ_ONLY');
  assert.deepEqual(await readdir('/var/lib/planner/staging'), stagedBefore);
  assert.equal(await db.collection('commands').countDocuments({ generationId }), 0);
  app('restart');
  await ready(200);
  assert.equal((await api(privateBoard, { session: owner })).status, 200);
  assert.equal((await change()).status, 409);
  const backup = JSON.parse(execFileSync('/usr/bin/plannerctl', ['backup', 'create', '--json'], { encoding: 'utf8' }));
  assert.match(backup.manifestSha256, /^[0-9a-f]{64}$/u);
  const writable = operator('enable-writes', '--run', runId);
  assert.equal(writable.state, 'writable');
  assert.deepEqual(operator('enable-writes', '--run', runId), writable);
  app('stop');
  const checkpoint = mode === 'rollback' ? 'batchStored' : 'firstWriteFenced';
  await killAt({ checkpoint, key, cardId, ownerId, revision, name, token: owner.cookie.split('=')[1] });
  const stored = await db.collection('commands').findOne({ generationId, idempotencyKey: key });
  assert.equal(stored.status, 'building');
  assert.equal((await db.collection('cards').findOne({ generationId, id: cardId })).revision, revision);
  if (mode === 'rollback') {
    const rolledBack = operator('rollback', '--expect-generation', generationId);
    assert.equal(rolledBack.state, 'rolledBack');
    assert.equal(rolledBack.activeGenerationId, null);
    assert.deepEqual(operator('rollback', '--expect-generation', generationId), rolledBack);
    app('start');
    await ready(503);
    assert.equal((await api(cardPath, { session: owner })).status, 503);
    console.log('Native read-only cutover, ACL and download checks, and pre-fence rollback passed.');
  } else {
    refuses('rollback-fenced', 'rollback', '--expect-generation', generationId);
    app('start');
    await ready(200);
    const recovery = JSON.parse(execFileSync('/usr/bin/plannerctl', ['backup', 'create', '--json'], { encoding: 'utf8' }));
    assert.match(recovery.manifestSha256, /^[0-9a-f]{64}$/u);
    assert.notEqual(recovery.backupId, backup.backupId);
    assert.equal((await db.collection('commands').findOne({ _id: stored._id })).status, 'building');
    assert.equal((await change()).status, 200);
    assert.equal((await change()).status, 200);
    assert.equal((await db.collection('cards').findOne({ generationId, id: cardId })).name, name);
    assert.equal(await db.collection('commands').countDocuments({ generationId, idempotencyKey: key, status: 'committed' }), 1);
    assert.equal(await db.collection('auditEntries').countDocuments({ generationId, commandId: stored.id }), 1);
    assert.equal(await db.collection('events').countDocuments({ generationId, commandId: stored.id }), 1);
    refuses('rollback-fenced', 'rollback', '--expect-generation', generationId);
    console.log('Native post-fence rollback refusal and exact authenticated journal replay passed.');
  }
}

try {
  if (args[0] === 'command-child') await commandChild();
  else await qualify();
} finally { await client.close(); }
