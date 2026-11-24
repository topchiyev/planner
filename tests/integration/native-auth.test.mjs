import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { createFirstAdminEnrollment, firstAdminBinding, hasFirstAdminGrant, recoverFirstAdmin } from '../../apps/backend/dist/application/auth/first-admin.js';
import { newToken, tokenDigest } from '../../apps/backend/dist/application/auth/credentials.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { buildApp } from '../../apps/backend/dist/build-app.js';
import { startProxySocket } from '../../apps/backend/dist/native/proxy-socket.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema, readInstallation } from '../../apps/backend/dist/storage/schema.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);
const origin = 'https://planner.example.test';
const authority = new URL(origin).host;
const proxyToken = 'a'.repeat(64);
const frontendRoot = fileURLToPath(new URL('../../apps/frontend/dist/', import.meta.url));
const issuedAt = new Date('2026-03-19T13:13:59.719Z');
const expiresAt = new Date(issuedAt.getTime() + 30 * 60_000);
const password = '  µniCODE 🗝️ ! & + %  ';
const inlineVerifier = { version: 'scrypt-v1', salt: '1'.repeat(32), key: '2'.repeat(64) };

async function setup({ db, directory }, { checkpoint, hasher = createPasswordHasher() } = {}) {
  const installationId = randomUUID();
  const generationId = randomUUID();
  const grantId = randomUUID();
  const grant = newToken();
  const grantKey = workspaceKey(generationId, grantId);
  const recoveryGrants = db.collection('recoveryGrants');
  const users = db.collection('users');
  const installation = db.collection('installation');
  await installation.insertOne({
    _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: null,
    setup: { mode: 'fresh', pendingAction: 'first-admin-enrollment', enrollmentGenerationId: generationId, firstAdminGrantIssuedAt: issuedAt },
  });
  await recoveryGrants.insertOne({
    _id: grantKey, id: grantId, installationId, generationId, kind: 'first-admin',
    tokenDigest: tokenDigest(grant), issuedAt, expiresAt, consumedAt: null,
  });
  await migrateStorageSchema(db, installationId);
  const writer = join(directory, 'writer');
  await mkdir(writer, { mode: 0o750 });
  const owner = process.getuid();
  const group = process.getgid();
  let time = new Date(issuedAt.getTime() + 1_000);
  let gate;
  const makeGate = () => new CommandGate(acquireWriterDirectory(writer, owner, group));
  async function reboot() {
    await gate?.closeAndDrain();
    gate = makeGate();
    await new CommandJournal(gate, db, installationId).recover(() => recoverFirstAdmin(db, installationId));
  }
  await reboot();
  const now = () => time;
  return {
    installationId, generationId, grant, grantKey, installation, recoveryGrants, users, now,
    setTime: (nextTime) => { time = nextTime; },
    reboot, gate: () => gate, close: () => gate.closeAndDrain(),
    sessions: () => createBrowserSessions(db, installationId, gate, hasher, now),
    input: { grant, name: 'Synthetic Operator', email: 'Admin@EXAMPLE.test', password },
    confirm: (input) => createFirstAdminEnrollment(db, installationId, gate, hasher, now, checkpoint)(input),
  };
}

for (const rejectedAt of ['claimed', 'account', 'audited', 'published']) {
  test(`recovery converges after interruption at first-admin checkpoint ${rejectedAt}`, { timeout: 25_000 }, async () => {
    await withFixtureMongo(async (mongo) => {
      const powerLoss = new Error('test interruption');
      const fixture = await setup(mongo, {
        hasher: { encode: async () => inlineVerifier },
        checkpoint: (checkpoint) => { if (checkpoint === rejectedAt) throw powerLoss; },
      });
      const { installation, generationId, grantKey, recoveryGrants, users } = fixture;
      try {
        await assert.rejects(fixture.confirm(fixture.input), powerLoss);
        assert.equal(fixture.gate().state, 'maintenance');
        const pending = await recoveryGrants.findOne({ _id: grantKey });
        const accountId = pending.firstAdminClaim.accountId;
        assert.match(accountId, /-4[0-9a-f]{3}-[89ab]/u);
        assert.deepEqual(pending.firstAdminClaim.passwordVerifier, inlineVerifier);
        assert.equal((await installation.findOne({})).activeGenerationId,
          rejectedAt === 'published' ? generationId : null);

        fixture.setTime(new Date(expiresAt.getTime() + 60_000));
        await fixture.reboot();
        await fixture.reboot();
        assert.equal(fixture.gate().ready, true);
        assert.equal(await fixture.confirm(fixture.input), false);
        assert.equal((await installation.findOne({})).setup.pendingAction, 'complete');
        assert.equal((await installation.findOne({})).activeGenerationId, generationId);
        assert.equal((await recoveryGrants.findOne({ _id: grantKey })).firstAdminClaim, undefined);
        assert.equal(await users.countDocuments({}), 1);
        assert.equal((await users.findOne({})).id, accountId);
        const audit = await mongo.db.collection('auditEntries').find().toArray();
        assert.equal(audit.length, 1);
        assert.equal(audit[0].actorId, accountId);
        assert.equal(audit[0].action, 'first-admin-enrollment');
        const traffic = JSON.stringify(audit);
        for (const secret of [fixture.grant, tokenDigest(fixture.grant), password, inlineVerifier.key]) {
          assert.equal(traffic.includes(secret), false);
        }
        for (const collection of ['commands', 'commandEffectBatches', 'events', 'sessions']) {
          assert.equal(await mongo.db.collection(collection).countDocuments({}), 0);
        }
      } finally { await fixture.close(); }
    });
  });
}

test('expired, foreign and concurrent first-admin grants cannot create a second administrator', { timeout: 30_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const fixture = await setup(mongo, { hasher: { encode: async () => inlineVerifier } });
    try {
      const other = newToken();
      assert.equal(await fixture.confirm({ ...fixture.input, grant: other }), false);
      const original = await fixture.recoveryGrants.findOne({ _id: fixture.grantKey });
      const unrelatedId = randomUUID();
      await fixture.recoveryGrants.updateOne({ _id: fixture.grantKey }, { $set: { installationId: unrelatedId } });
      assert.equal(await fixture.confirm(fixture.input), false);
      await fixture.recoveryGrants.replaceOne({ _id: fixture.grantKey }, original);
      fixture.setTime(expiresAt);
      assert.equal(await fixture.confirm(fixture.input), false);
      assert.equal((await fixture.recoveryGrants.findOne({})).consumedAt, null);
      assert.equal(await fixture.users.countDocuments({}), 0);
      fixture.setTime(new Date(expiresAt.getTime() - 1));
      assert.deepEqual((await Promise.all([fixture.confirm(fixture.input), fixture.confirm(fixture.input)])).sort(), [false, true]);
      assert.equal(await fixture.users.countDocuments({}), 1);
    } finally { await fixture.close(); }
  });
});

function proxyRequest(socketPath, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, path, method, headers: {
        'X-Planner-Proxy-Token': proxyToken,
        'X-Forwarded-Host': authority,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '192.0.2.9',
        ...(payload && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, async (response) => {
      try {
        let data = '';
        for await (const chunk of response) data += chunk;
        resolve({ status: response.statusCode, headers: response.headers, data });
      } catch (error) { reject(error); }
    });
    req.once('error', reject).end(payload);
  });
}

test('native HTTP confirms setup, gates the workspace, authenticates only trusted HTTPS and revokes safely', { timeout: 40_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const { db, directory } = mongo;
    const fixture = await setup(mongo);
    const proxyDir = join(directory, 'proxy');
    await mkdir(proxyDir);
    await chmod(proxyDir, 0o711);
    const app = buildApp({
      frontendRoot,
      native: { origin, proxyToken,
        readAccess: async () => fixture.gate().ready
          ? fixture.gate().readSnapshot(async () => {
            const installation = await readInstallation(db, fixture.installationId);
            if (firstAdminBinding(installation)?.published) return { kind: 'ready' };
            return await hasFirstAdminGrant(db, installation, fixture.now()) ? { kind: 'enrollment', step: 'recovery' }
              : { kind: 'unavailable', reason: 'setup' };
          }) : { kind: 'unavailable', reason: 'schema-or-recovery' },
        auth: { confirm: fixture.confirm, ...fixture.sessions() },
      },
    });
    app.get('/files/fixture', (req) => ({ actor: req.plannerSession.account }));
    app.post('/api/v1/test-mutation', (req) => ({ actor: req.plannerSession.account }));
    const stop = await startProxySocket(proxyDir, app);
    const call = (path, options) => proxyRequest(join(proxyDir, 'http.sock'), path, options);
    const post = (path, body, headers = { origin }) => call(path, { method: 'POST', headers, body });
    try {
      assert.equal((await call('/recover')).status, 200);
      for (const path of ['/sign-in', '/workspace', '/files/fixture', '/api/v1/session', '/oauth/consent', '/mcp']) {
        assert.equal((await call(path)).status, 503);
      }
      const recover = '/api/v1/recovery/consume';
      assert.equal((await post(recover, fixture.input, { origin: 'https://other.invalid' })).status, 503);
      assert.equal((await post(recover, '{wrong-secret')).status, 400);
      assert.equal((await post(recover, 'a'.repeat(4097))).status, 400);
      const max = { ...fixture.input, password: '𐀀'.repeat(128) };
      const escaped = JSON.stringify(max).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const confirmed = await post(recover, escaped);
      assert.equal(confirmed.status, 200, confirmed.data);
      assert.deepEqual(JSON.parse(confirmed.data), { status: 'confirmed' });
      assert.equal(confirmed.headers['set-cookie'], undefined);
      assert.equal((await post(recover, fixture.input)).status, 400);
      assert.equal((await call('/health/ready')).status, 200);
      const login = '/api/v1/session/login';
      const identity = { identifier: ' ADMIN@example.test ', password: max.password };
      const denied = await post(login, { ...identity, password: 'unrelated secret password' });
      const missing = await post(login, { ...identity, identifier: 'unregistered@example.test' });
      assert.equal(denied.status, 401);
      assert.equal(missing.status, 401);
      for (const { data, headers } of [denied, missing]) {
        assert.equal(headers['set-cookie'], undefined);
        assert.equal(headers['cache-control'], 'no-store');
        const { requestId, ...body } = JSON.parse(data).error;
        assert.ok(requestId);
        assert.deepEqual(body, { code: 'INVALID_CREDENTIALS', message: 'Incorrect identifier or password.' });
      }
      assert.equal((await post(login, identity, { origin: 'https://other.invalid' })).status, 403);
      assert.equal((await app.inject({ method: 'POST', url: login, headers: { origin, 'x-planner-proxy-token': proxyToken }, payload: identity })).statusCode, 403);
      assert.equal((await call('/workspace')).headers.location, '/sign-in');
      assert.equal((await call('/files/fixture', { method: 'HEAD' })).status, 401);

      const signedIn = await post(login, identity);
      assert.equal(signedIn.status, 200);
      const session = JSON.parse(signedIn.data);
      assert.deepEqual(Object.keys(session).sort(), ['account', 'csrfToken', 'status']);
      assert.deepEqual(Object.keys(session.account).sort(), ['id', 'name', 'role']);
      const setCookie = signedIn.headers['set-cookie'][0];
      assert.match(setCookie, /; Path=\/; Secure; HttpOnly; SameSite=Lax$/u);
      const cookie = setCookie.split(';')[0];
      const current = await call('/api/v1/session', { headers: { cookie } });
      assert.deepEqual(JSON.parse(current.data), session);
      assert.equal((await call('/workspace', { headers: { cookie } })).status, 200);
      assert.equal((await app.inject({ url: '/files/fixture', headers: { cookie } })).statusCode, 401);
      assert.equal((await call('/files/fixture', { headers: { cookie } })).status, 200);
      const deleteRequest = (headers) => call('/api/v1/session', { method: 'DELETE', headers });
      assert.equal((await deleteRequest({ cookie, origin })).status, 403);
      assert.equal((await deleteRequest({ cookie, origin: 'https://bad.invalid', 'x-csrf-token': session.csrfToken })).status, 403);
      assert.equal((await post('/api/v1/test-mutation', undefined, { cookie, origin })).status, 403);
      assert.equal((await post('/api/v1/test-mutation', undefined, { cookie, origin, 'x-csrf-token': session.csrfToken })).status, 200);
      const ended = await deleteRequest({ cookie, origin, 'x-csrf-token': session.csrfToken });
      assert.equal(ended.status, 204);
      assert.match(ended.headers['set-cookie'][0], /Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Lax$/u);
      assert.equal((await call('/api/v1/session', { headers: { cookie } })).status, 401);
      assert.equal((await call('/files/fixture', { headers: { cookie } })).status, 401);

      for (let index = 0; index < 5; index++) {
        assert.equal((await post(login, { identifier: 'repeat@example.test', password })).status, 401);
      }
      assert.equal((await post(login, { identifier: ' REPEAT@example.test ', password }, { origin, 'X-Forwarded-For': '192.0.2.44' })).status, 429);
      assert.equal(await db.collection('auditEntries').countDocuments({}), 1);
      const workspace = await openActiveWorkspace(db, fixture.installationId);
      assert.equal((await workspace.read('users', session.account.id)).localAuth, undefined);
      await assert.rejects(() => workspace.read('recoveryGrants', session.account.id), /available to the workspace/u);
      await assert.rejects(() => workspace.update('users', session.account.id, { localAuth: null }, 1), /protected storage/u);
      const persisted = await db.collection('sessions').findOne({});
      const rawToken = cookie.split('=')[1];
      assert.equal(persisted.tokenDigest, tokenDigest(rawToken));
      assert.equal(JSON.stringify(persisted).includes(rawToken), false);
      assert.equal(JSON.stringify(persisted).includes(session.csrfToken), false);
    } finally {
      await stop();
      await app.close();
      await fixture.close();
    }
  });
});

test('sessions expire on inactivity, absolute time, installation/generation, and current account changes', { timeout: 25_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const hasher = { encode: async () => inlineVerifier, verify: async (value, stored) => value === password && !!stored };
    const fixture = await setup(mongo, { hasher });
    try {
      assert.equal(await fixture.confirm(fixture.input), true);
      const sessions = fixture.sessions();
      const login = () => sessions.login({ identifier: 'admin@example.test', password });
      const update = ($set) => fixture.users.updateOne({}, { $set });
      await update({ 'preferences.autoLogout': '2m' });
      const signed = await login();
      assert.equal(signed.status, 'authenticated');
      fixture.setTime(new Date(fixture.now().getTime() + 119_000));
      assert.ok(await sessions.read(signed.token));
      fixture.setTime(new Date(fixture.now().getTime() + 120_000));
      assert.equal(await sessions.read(signed.token), null);
      assert.equal(await sessions.revoke(signed.token), false);

      await update({ 'preferences.autoLogout': 'never' });
      const absolute = await login();
      fixture.setTime(new Date(fixture.now().getTime() + 30 * 24 * 60 * 60_000 - 1));
      assert.ok(await sessions.read(absolute.token));
      fixture.setTime(new Date(fixture.now().getTime() + 1));
      assert.equal(await sessions.read(absolute.token), null);

      const current = await login();
      const { installationId, generationId, installation } = fixture;
      await installation.updateOne({}, { $set: { activeGenerationId: randomUUID() } });
      assert.equal(await sessions.read(current.token), null);
      await installation.updateOne({}, { $set: { activeGenerationId: generationId } });
      const records = mongo.db.collection('sessions');
      await records.updateOne({ tokenDigest: tokenDigest(current.token) }, { $set: { installationId: randomUUID() } });
      assert.equal(await sessions.read(current.token), null);
      await records.updateOne({ tokenDigest: tokenDigest(current.token) }, { $set: { installationId } });
      await update({ 'localAuth.credentialsVersion': 2 });
      assert.equal(await sessions.read(current.token), null);
      const protectedSession = await login();
      await update({ 'localAuth.mfa': 'enrollment-required' });
      assert.equal((await login()).status, 'enrollment-required');
      assert.equal(await sessions.read(protectedSession.token), null);
      await update({ 'localAuth.mfa': 'totp' });
      assert.equal((await login()).status, 'invalid');
      await update({ 'localAuth.mfa': 'none', disabledAt: fixture.now() });
      assert.equal((await login()).status, 'invalid');
      assert.equal(await sessions.read(protectedSession.token), null);
    } finally { await fixture.close(); }
  });
});
