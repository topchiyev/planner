import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AccountActionError } from '../../apps/backend/dist/application/auth/account-policy.js';
import { tokenDigest } from '../../apps/backend/dist/application/auth/credentials.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { accountAccessApprovalOperation } from '../../apps/backend/dist/application/command-journal/operation.js';
import { enableMigrationWrites, rollbackMigration } from '../../apps/backend/dist/application/migration/cutover.js';
import { GateUnavailableError } from '../../apps/backend/dist/application/command-gate/gate.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { accountFixture, callSocket, changedPassword, password, proxyHeaders } from '../support/account-fixture.mjs';
import { publishSyntheticMigration } from '../support/migration-activation-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);
const origin = 'https://planner.example.test';
const url = '/api/v1/admin/accounts';
const sessionHeaders = (result) => ({ Cookie: result.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': result.data.csrfToken });
const accountError = (kind) => (error) => error instanceof AccountActionError && error.kind === kind;

test('native private proxy scopes directory, profile, preferences and provisioning to the verified session', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    const proxy = await f.startBrowser(origin);
    const call = (path, method, body, headers = {}) => callSocket(proxy.path, path, {
      method, body, headers: { ...proxyHeaders(origin), Origin: origin, ...headers },
    });
    const login = async (email) => call('/api/v1/session/login', 'POST', { identifier: email, password });
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      await f.seed('owner@example.test', { role: 'projectOwner' });
      await f.seed('viewer@example.test', { name: 'Visible Member', username: 'private-alias' });
      await f.seed('disabled@example.test', { disabledAt: new Date() });
      const me = sessionHeaders(await login('ADMIN@example.test'));
      const owner = sessionHeaders(await login('owner@example.test'));
      const viewer = sessionHeaders(await login('viewer@example.test'));

      assert.equal((await call(url, 'GET', undefined, viewer)).status, 403);
      assert.equal((await call(url, 'GET', undefined, { ...me, 'X-Forwarded-For': 'unknown address' })).status, 401);
      const choices = await call(url, 'GET', undefined, owner);
      assert.equal(choices.data.access, 'directory');
      assert.equal(choices.data.accounts.length, 3);
      assert.deepEqual(Object.keys(choices.data.accounts[0]).sort(), ['id', 'name', 'role']);

      for (const q of ['viewer@example.test', 'private-alias']) {
        const path = url + '?q=' + encodeURIComponent(q);
        assert.equal((await call(path, 'GET', undefined, me)).data.accounts.length, 1);
        assert.equal((await call(path, 'GET', undefined, owner)).data.accounts.length, 0);
      }
      assert.equal((await call(url + '?q=Visible', 'GET', undefined, owner)).data.accounts.length, 1);

      const data = { name: 'New account', email: ' New@Example.test ', username: '  Cafe\u0301  ', role: 'boardUser' };
      assert.equal((await call(url, 'POST', data, { ...owner, 'Idempotency-Key': randomUUID() })).status, 403);
      assert.equal((await call(url, 'POST', data, { ...me, Origin: 'https://other.invalid' })).status, 403);
      assert.equal((await call(url, 'POST', data, { Cookie: me.Cookie })).status, 403);
      const key = randomUUID();
      const created = await call(url, 'POST', data, { ...me, 'Idempotency-Key': key });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.match(created.data.id, /-4[0-9a-f]{3}-[89ab]/u);
      assert.equal(created.data.signIn, 'password-required');
      assert.deepEqual((await call(url, 'POST', data, { ...me, 'Idempotency-Key': key })).data, created.data);
      assert.equal((await call(url, 'POST', { ...data, name: 'Different' }, { ...me, 'Idempotency-Key': key })).status, 409);

      for (const change of [{ email: 'new@example.test', username: null }, { email: 'unique@example.test', username: 'CAFÉ' },
        { email: 'unique@example.test', username: 'ADMIN@EXAMPLE.TEST' }]) {
        const conflict = await call(url, 'POST', { ...data, ...change }, { ...me, 'Idempotency-Key': randomUUID() });
        assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
        assert.equal(conflict.data.error.code, 'IDENTIFIER_IN_USE');
      }
      const invalid = await call(url, 'POST', { ...data, email: 'unique@example.test', username: 'name / bad' },
        { ...me, 'Idempotency-Key': randomUUID() });
      assert.equal(invalid.status, 400);
      for (const [email, name] of [['one@example.test', 'One null username'], ['two@example.test', 'Two null usernames']]) {
        assert.equal((await call(url, 'POST', { ...data, email, name, username: null }, { ...me, 'Idempotency-Key': randomUUID() })).status, 201);
      }

      const profile = '/api/v1/me/profile';
      const profileOriginal = await call(profile, 'GET', undefined, me);
      assert.equal(profileOriginal.data.id, admin.id);
      assert.equal(profileOriginal.data.username, null);
      const change = { revision: 1, username: 'Personal.handle', organization: 'Planner' };
      assert.equal((await call(profile, 'PATCH', change, { ...me, 'Idempotency-Key': randomUUID() })).status, 403);
      const renamed = await call(profile, 'PATCH', { ...change, currentPassword: password }, { ...me, 'Idempotency-Key': randomUUID() });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
      assert.equal(renamed.data.username, 'Personal.handle');
      assert.equal((await login(' personal.HANDLE ')).status, 200);
      const preferences = '/api/v1/me/preferences';
      const updated = await call(preferences, 'PATCH', { revision: 2, preferences: { autoLogout: '5m', editorMode: 'markup' } },
        { ...me, 'Idempotency-Key': randomUUID() });
      assert.equal(updated.status, 200, JSON.stringify(updated.data));
      assert.equal(updated.data.preferences.autoLogout, '5m');
      assert.equal(updated.data.preferences.homeView, 'groupedProjects');
      assert.equal(updated.data.revision, 3);
      assert.equal((await call(profile, 'PATCH', { revision: 1, name: 'stale' }, { ...me, 'Idempotency-Key': randomUUID() })).status, 409);
      const traffic = JSON.stringify(await mongo.db.collection('commands').find(f.scope).toArray());
      assert.equal(traffic.includes(password), false);
      assert.equal(traffic.includes(me.Cookie), false);
      assert.equal(await mongo.db.collection('auditEntries').countDocuments({ ...f.scope, action: 'account.provision' }), 3);
      const base = await mongo.db.collection('users').findOne({ _id: admin._id });
      await mongo.db.collection('users').insertMany(Array.from({ length: 104 }, (_, index) => {
        const id = randomUUID();
        const email = `page-${index}@example.test`;
        const { localAuth: _local, ...fields } = base;
        return { ...fields, _id: `${f.generationId}/${id}`, id, name: `Page ${index}`, email, normalizedEmail: email,
          username: null, normalizedUsername: null, role: 'boardUser' };
      }));
      const page = await call(url, 'GET', undefined, me);
      assert.equal(page.data.accounts.length, 25);
      assert.match(page.data.next, /^v1\.[A-Za-z0-9_-]+$/u);
      const next = url + '?cursor=' + encodeURIComponent(page.data.next);
      const page2 = await call(next, 'GET', undefined, me);
      assert.equal(page2.status, 200);
      assert.equal(page2.data.accounts.length, 25);
      assert.ok(page2.data.accounts[0].id > page.data.accounts.at(-1).id);
      for (const [path, headers] of [[next, owner], [next + '&q=page', me], [next + '&limit=26', me], [url + '?cursor=' + admin.id, me]]) {
        assert.equal((await call(path, 'GET', undefined, headers)).status, 400);
      }
      assert.equal((await call(url + '?limit=500', 'GET', undefined, me)).data.accounts.length, 100);
      assert.equal(f.gate().ready, true);
    } finally { await proxy.close(); await f.close(); }
  });
});

test('local approvals serialize last-admin protection and preserve disabled accounts and memberships', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    const local = await f.startOperator();
    const operator = (id, method = 'GET') => callSocket(local.path, '/accounts/approvals/' + id + (method === 'POST' ? '/confirm' : ''), { method });
    try {
      const a = await f.seed('a@example.test', { role: 'admin' });
      const b = await f.seed('b@example.test', { role: 'admin' });
      await f.seed('no-password@example.test', { role: 'admin', password: false });
      await f.seed('invalid-verifier@example.test', { role: 'admin', invalidVerifier: true });
      await f.seed('blocked-totp@example.test', { role: 'admin', factor: 'enrollment-required' });
      await f.seed('disabled-admin@example.test', { role: 'admin', disabledAt: new Date() });
      const firstSession = await f.sessions().login({ identifier: a.email, password });
      const secondSession = await f.sessions().login({ identifier: b.email, password });
      const svc = f.accountServices();
      const [demotion, disable] = await Promise.all([
        svc.requestApproval(firstSession.token, a.id, a.id, 1, { action: 'role', role: 'projectOwner' }),
        svc.requestApproval(secondSession.token, b.id, b.id, 1, { action: 'availability', disabled: true }),
      ]);
      assert.deepEqual((await operator(disable.id)).data, disable);
      assert.equal((await mongo.db.collection('users').findOne({ _id: b._id })).disabledAt, null);
      const membership = randomUUID();
      const store = await openActiveWorkspace(mongo.db, f.installationId);
      await store.insert('boardMembers', membership, { boardId: randomUUID(), userId: b.id });
      const [disabled, refused] = await Promise.all([svc.confirmApproval(disable.id), operator(demotion.id, 'POST')]);
      assert.equal(disabled.outcome, 'applied');
      assert.equal(refused.status, 409);
      assert.equal(refused.data.code, 'LAST_USABLE_ADMIN');
      assert.equal((await operator(disable.id, 'POST')).status, 409);
      assert.equal(await f.sessions().read(secondSession.token), null);
      assert.equal((await f.sessions().login({ identifier: b.email, password })).status, 'invalid');
      assert.equal((await store.read('boardMembers', membership)).userId, b.id);
      assert.equal((await mongo.db.collection('users').findOne({ _id: b._id })).id, b.id);
      await assert.rejects(svc.requestApproval(firstSession.token, a.id, a.id, 1, { action: 'recovery' }), accountError('lastAdmin'));

      const stale = await svc.requestApproval(firstSession.token, a.id, b.id, 2, { action: 'availability', disabled: false });
      f.advanceBy(10 * 60_000);
      assert.equal((await operator(stale.id, 'POST')).status, 409);
      const reopen = await svc.requestApproval(firstSession.token, a.id, b.id, 2, { action: 'availability', disabled: false });
      assert.equal((await operator(reopen.id, 'POST')).status, 200);
      assert.equal(await f.sessions().read(secondSession.token), null);
      assert.equal((await f.sessions().login({ identifier: b.email, password })).status, 'authenticated');
      const history = await mongo.db.collection('auditEntries').find({ ...f.scope, resourceId: b.id }).toArray();
      assert.equal(history.length, 2);
      assert.ok(history.every((item) => item.origin === 'operator' && item.action === 'account.availability'));
    } finally { await local.close(); await f.close(); }
  });
});

test('isolated credential transitions recover after interruption and enforce one-use recovery, fresh sessions and MFA restriction', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      const target = await f.seed('target@example.test');
      const imported = await f.seed('import@example.test', { id: '36a521cf-7e15-5fea-aefa-657dadccda94',
        role: 'projectOwner', password: false, requiresMfaEnrollment: true });
      const adminSession = await f.sessions().login({ identifier: admin.email, password });
      const old = await f.sessions().login({ identifier: target.email, password });
      const other = await f.sessions().login({ identifier: target.email, password });
      const { db } = mongo;
      for (const [name, field] of [['trustedDevices', 'tokenDigest'], ['oauthArtifacts', 'artifactId'], ['oauthConnections', 'providerGrantId']]) {
        const id = randomUUID();
        await db.collection(name).insertOne({ _id: `${f.generationId}/${id}`, ...f.scope, id, kind: 'fixture',
          userId: target.id, [field]: id, revokedAt: null });
      }
      const interrupted = f.accountServices(() => { throw new Error('test interruption'); });
      await assert.rejects(interrupted.changePassword(old.token, target.id, { currentPassword: password, password: changedPassword }), /test interruption/u);
      assert.equal(f.gate().state, 'maintenance');
      await assert.rejects(f.sessions().read(other.token), GateUnavailableError);
      assert.equal((await db.collection('users').findOne({ _id: target._id })).localAuth.credentialsVersion, 2);
      await f.reboot();
      await f.reboot();
      assert.equal(await f.sessions().read(old.token), null);
      assert.equal(await f.sessions().read(other.token), null);
      assert.equal((await f.sessions().login({ identifier: target.email, password })).status, 'invalid');
      const loggedIn = await f.sessions().login({ identifier: target.email, password: changedPassword });
      assert.equal(loggedIn.status, 'authenticated');
      for (const name of ['trustedDevices', 'oauthArtifacts', 'oauthConnections']) {
        assert.ok((await db.collection(name).findOne({ ...f.scope, userId: target.id })).revokedAt instanceof Date);
      }
      assert.equal(await db.collection('auditEntries').countDocuments({ ...f.scope, action: 'account.password-changed', origin: 'web' }), 1);

      const svc = f.accountServices();
      const approval = await svc.requestApproval(adminSession.token, admin.id, imported.id, 1, { action: 'recovery' });
      assert.ok(!JSON.stringify(approval).includes('grant'));
      const reset = await svc.confirmApproval(approval.id);
      const grant = reset.recovery.grant;
      await assert.rejects(svc.confirmApproval(approval.id), accountError('approval'));
      const outcomes = await Promise.allSettled([
        svc.consumeRecovery({ grant, password }),
        svc.consumeRecovery({ grant, password: changedPassword }),
      ]);
      assert.deepEqual(outcomes[0], { status: 'fulfilled', value: { status: 'enrollment-required' } });
      assert.equal(outcomes[1].reason.kind, 'grant');
      const restricted = await f.sessions().login({ identifier: imported.email, password });
      assert.deepEqual(restricted, { status: 'enrollment-required' });
      const importedAfter = await db.collection('users').findOne({ _id: imported._id });
      assert.equal(importedAfter.id, imported.id);
      assert.equal(importedAfter.role, imported.role);
      assert.equal(importedAfter.accountChange, undefined);
      const audit = JSON.stringify(await db.collection('auditEntries').find(f.scope).toArray());
      for (const secret of [grant, tokenDigest(grant), password, changedPassword, loggedIn.token, importedAfter.localAuth.passwordVerifier.key]) {
        assert.equal(audit.includes(secret), false);
      }
    } finally { await f.close(); }
  });
});

test('operator replay checks the original approval and post-effect state before completing after expiry', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    const { db } = mongo;
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      const target = await f.seed('member@example.test');
      const login = await f.sessions().login({ identifier: admin.email, password });
      const svc = f.accountServices();
      const requested = await svc.requestApproval(login.token, admin.id, target.id, 1, { action: 'role', role: 'projectOwner' });
      const approval = { ...f.scope, id: requested.id };
      const targetMatch = { _id: target._id, ...f.scope };
      await assert.rejects(f.accountServices(() => { throw new Error('test interruption'); }).confirmApproval(requested.id), /test interruption/u);
      assert.equal((await db.collection('users').findOne(targetMatch)).role, 'projectOwner');

      await db.collection('recoveryGrants').updateOne(approval, { $set: { change: { action: 'recovery' } } });
      await assert.rejects(f.reboot(), /does not match the recorded approval/u);
      assert.equal(f.gate().ready, false);
      assert.equal((await db.collection('recoveryGrants').findOne(approval)).consumedAt, null);
      assert.equal(await db.collection('auditEntries').countDocuments(f.scope), 0);

      await db.collection('recoveryGrants').updateOne(approval, { $set: { change: requested.change } });
      await db.collection('users').updateOne(targetMatch, { $set: { role: 'boardUser' } });
      await assert.rejects(f.reboot(), /state does not match the recorded approval/u);
      assert.equal(await db.collection('auditEntries').countDocuments(f.scope), 0);

      await db.collection('users').updateOne(targetMatch, { $set: { role: 'projectOwner' } });
      f.advanceBy(11 * 60_000);
      await f.reboot();
      await f.reboot();
      assert.equal(f.gate().ready, true);
      assert.ok((await db.collection('recoveryGrants').findOne(approval)).consumedAt instanceof Date);
      assert.equal((await db.collection('users').findOne(targetMatch)).accountChange, undefined);
      assert.equal(await db.collection('auditEntries').countDocuments({ ...f.scope, action: 'account.role', origin: 'operator' }), 1);
    } finally { await f.close(); }
  });
});

test('a later role change and expiration invalidate outstanding recovery delivery', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      const target = await f.seed('member@example.test');
      const login = await f.sessions().login({ identifier: admin.email, password });
      const svc = f.accountServices();
      async function reset(revision) {
        const approval = await svc.requestApproval(login.token, admin.id, target.id, revision, { action: 'recovery' });
        return (await svc.confirmApproval(approval.id)).recovery.grant;
      }
      const first = await reset(1);
      const promote = await svc.requestApproval(login.token, admin.id, target.id, 2, { action: 'role', role: 'projectOwner' });
      await svc.confirmApproval(promote.id);
      await assert.rejects(svc.consumeRecovery({ grant: first, password }), accountError('grant'));
      const expiring = await reset(3);
      f.advanceBy(30 * 60_000);
      await assert.rejects(svc.consumeRecovery({ grant: expiring, password }), accountError('grant'));
      const final = await reset(4);
      assert.deepEqual(await svc.consumeRecovery({ grant: final, password }), { status: 'confirmed' });
      const member = await f.sessions().login({ identifier: target.email, password });
      assert.equal(member.session.account.role, 'projectOwner');
    } finally { await f.close(); }
  });
});

test('reset replay fails closed before completing a revoked grant', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    const { db } = mongo;
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      const target = await f.seed('member@example.test');
      const login = await f.sessions().login({ identifier: admin.email, password });
      const svc = f.accountServices();
      const approval = await svc.requestApproval(login.token, admin.id, target.id, 1, { action: 'recovery' });
      const grant = (await svc.confirmApproval(approval.id)).recovery.grant;
      await assert.rejects(f.accountServices(() => { throw new Error('test interruption'); }).consumeRecovery({
        grant, password: changedPassword,
      }), /test interruption/u);
      const filter = { ...f.scope, kind: 'account-recovery', userId: target.id, tokenDigest: tokenDigest(grant) };
      await db.collection('recoveryGrants').updateOne(filter, { $set: { revokedAt: new Date() } });
      await assert.rejects(f.reboot(), /missing or revoked/u);
      assert.equal((await db.collection('recoveryGrants').findOne(filter)).consumedAt, null);
      assert.equal(await db.collection('auditEntries').countDocuments({ ...f.scope, action: 'account.reset-consumed' }), 0);
      assert.equal(f.gate().ready, false);
      await db.collection('recoveryGrants').updateOne(filter, { $set: { revokedAt: null } });
      await f.reboot();
      await f.reboot();
      assert.equal((await f.sessions().login({ identifier: target.email, password: changedPassword })).status, 'authenticated');
      assert.equal(await db.collection('auditEntries').countDocuments({ ...f.scope, action: 'account.reset-consumed' }), 1);
    } finally { await f.close(); }
  });
});

test('a read-only import refuses account-access changes and the first approval fences before private replay', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    const { db, generationId, installationId } = f;
    const browser = await f.startBrowser(origin);
    const operator = await f.startOperator();
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      const roleTarget = await f.seed('role@example.test');
      const availabilityTarget = await f.seed('availability@example.test');
      const recoveryTarget = await f.seed('recover@example.test', { password: false });
      const me = await f.sessions().login({ identifier: admin.email, password });
      const service = f.accountServices();
      const request = (target, action) => service.requestApproval(me.token, admin.id, target.id, 1, action);
      const cases = [
        [roleTarget, { action: 'role', role: 'projectOwner' }],
        [availabilityTarget, { action: 'availability', disabled: true }],
      ];
      const prior = await Promise.all(cases.map(([target, action]) => request(target, action)));
      const runId = await publishSyntheticMigration(db, { generationId, installationId, actorId: admin.id });
      for (const [index, [target, action]] of cases.entries()) {
        const denied = await callSocket(browser.path, `${url}/${target.id}`, { method: 'PATCH', body: { ...action, revision: 1 },
          headers: { ...proxyHeaders(origin), Origin: origin, Cookie: `__Host-planner-session=${me.token}`, 'X-CSRF-Token': me.session.csrfToken },
        });
        assert.equal(denied.status, 409);
        assert.equal(denied.data.error.code, 'WORKSPACE_READ_ONLY');
        const confirm = await callSocket(operator.path, `/accounts/approvals/${prior[index].id}/confirm`, { method: 'POST' });
        assert.equal(confirm.status, 409);
        assert.equal(confirm.data.code, 'WORKSPACE_READ_ONLY');
      }
      const passwordRecovery = await request(recoveryTarget, { action: 'recovery' });
      assert.ok((await service.confirmApproval(passwordRecovery.id)).recovery.grant);
      assert.equal(await db.collection('commands').countDocuments({ generationId }), 0);
      assert.equal((await db.collection('users').findOne({ _id: roleTarget._id })).role, roleTarget.role);
      assert.equal((await db.collection('users').findOne({ _id: availabilityTarget._id })).disabledAt, null);
      await f.close();
      const owner = { uid: process.getuid(), gid: process.getgid() };
      const lease = acquireWriterDirectory(join(f.directory, 'writer'), owner, owner);
      try { await enableMigrationWrites(db, lease, installationId, runId); } finally { lease.release(); }
      await f.reboot();

      const interrupted = f.accountServices(() => { throw new Error('test interruption'); });
      await assert.rejects(interrupted.confirmApproval(prior[0].id), /test interruption/u);
      const command = await db.collection('commands').findOne({ generationId, operationId: 'account.access-approval' });
      assert.equal(command.status, 'committed');
      assert.equal((await db.collection('installation').findOne()).migrationActivation.fence.commandId, command.id);
      assert.equal((await db.collection('users').findOne({ _id: roleTarget._id })).accountChange.kind, 'role');
      await f.reboot();
      assert.equal((await db.collection('users').findOne({ _id: roleTarget._id })).role, 'projectOwner');
      assert.equal(await db.collection('auditEntries').countDocuments({ generationId, action: 'account.role' }), 1);
      assert.equal((await f.accountServices().confirmApproval(prior[1].id)).outcome, 'applied');
      assert.ok((await db.collection('users').findOne({ _id: availabilityTarget._id })).disabledAt instanceof Date);
      assert.equal(await db.collection('commands').countDocuments({ generationId, operationId: 'account.access-approval', status: 'committed' }), 2);
    } finally { await operator.close(); await browser.close(); await f.close(); }
  });
});

test('recovery settles a fenced account admission after expiration without applying the account change', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    const { db, generationId, installationId } = f;
    const owner = { uid: process.getuid(), gid: process.getgid() };
    const writer = () => acquireWriterDirectory(join(f.directory, 'writer'), owner, owner);
    try {
      const admin = await f.seed('admin@example.test', { role: 'admin' });
      const target = await f.seed('member@example.test');
      const runId = await publishSyntheticMigration(db, { generationId, installationId, actorId: admin.id });
      await f.close();
      let lease = writer();
      try { await enableMigrationWrites(db, lease, installationId, runId); } finally { lease.release(); }
      await f.reboot();

      const session = await f.sessions().login({ identifier: admin.email, password });
      const change = { action: 'role', role: 'projectOwner' };
      const approval = await f.accountServices().requestApproval(session.token, admin.id, target.id, 1, change);
      const journal = new CommandJournal(f.gate(), db, installationId, {
        operations: { [accountAccessApprovalOperation]: {
          normalize: () => ({ actorEpoch: 1, targetEpoch: 1, targetRevision: 1, userId: target.id, change }),
          authorize: () => {},
          plan: () => ({ effects: [], result: null, audit: {
            resourceType: 'account', resourceId: target.id, action: accountAccessApprovalOperation, origin: 'operator',
          } }),
        } },
        checkpoint(point) { if (point === 'firstWriteFenced') throw new Error('test interruption at sealed approval fence'); },
      });
      await assert.rejects(journal.execute({ operationId: accountAccessApprovalOperation, actorId: admin.id, idempotencyKey: approval.id, input: null }),
        /interruption at sealed approval fence/u);
      const command = await db.collection('commands').findOne({ generationId, idempotencyKey: approval.id });
      assert.equal(command.status, 'building');
      assert.equal(await db.collection('auditEntries').countDocuments({ generationId }), 0);
      assert.equal(f.gate().ready, false);
      f.advanceBy(11 * 60_000);
      const batches = db.collection('commandEffectBatches');
      const batch = await batches.findOne({ generationId, commandId: command.id });
      await batches.updateOne({ _id: batch._id }, { $set: { payload: '[]' } });
      await assert.rejects(f.reboot(), /batch/u);
      assert.equal(f.gate().ready, false);
      await batches.updateOne({ _id: batch._id }, { $set: { payload: batch.payload } });

      await f.reboot();
      assert.equal((await db.collection('commands').findOne({ _id: command._id })).status, 'committed');
      assert.equal(await db.collection('auditEntries').countDocuments({ generationId, commandId: command.id }), 1);
      await assert.rejects(f.accountServices().confirmApproval(approval.id), accountError('approval'));
      assert.equal((await db.collection('users').findOne({ _id: target._id })).role, 'boardUser');
      assert.equal(await db.collection('auditEntries').countDocuments({ generationId, action: 'account.role' }), 0);
      const ordinary = await f.accountServices().updatePreferences(session.token, admin.id, randomUUID(),
        { revision: 1, preferences: { editorMode: 'markup', autoLogout: '5m' } });
      assert.equal(ordinary.revision, 2);
      await f.close();
      lease = writer();
      try {
        await assert.rejects(rollbackMigration(db, lease, installationId, generationId), { fault: 'rollback-fenced' });
        assert.equal((await db.collection('installation').findOne()).migrationActivation.fence.commandId, command.id);
      } finally { lease.release(); }
    } finally { await f.close(); }
  });
});
