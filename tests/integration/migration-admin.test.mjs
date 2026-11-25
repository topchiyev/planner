import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Secret, TOTP } from 'otpauth';
import { readMigrationAdminActivationProof } from '../../apps/backend/dist/application/auth/migration-admin.js';
import { tokenDigest } from '../../apps/backend/dist/application/auth/credentials.js';
import { readInstallation } from '../../apps/backend/dist/storage/schema.js';
import { callSocket, proxyHeaders } from '../support/account-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { migrationAdminFixture, stagedPassword } from '../support/migration-admin-fixture.mjs';

const refuses = (error) => error?.fault === 'target-setup';
const invalidGrant = (error) => error?.kind === 'grant';
const origin = 'https://staged-admin.example.test';
const fallback = { name: 'Approved fixture administrator', email: 'fallback@staged.example.test', approveFallback: true };

async function assertCold(mongo, scope) {
  assert.equal((await readInstallation(mongo, scope.installationId)).activeGenerationId, null);
  for (const collection of ['sessions', 'trustedDevices', 'oauthConnections', 'oauthArtifacts', 'events']) {
    assert.equal(await mongo.collection(collection).countDocuments({ generationId: scope.generationId }), 0, collection);
  }
}

test('exact imported administrator recovery is private, expires, rotates and proves fresh MFA before activation', { timeout: 55_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const fixture = await migrationAdminFixture(mongo);
    const { db, run, scope, seed, issue, now } = fixture;
    const first = await seed('101');
    const selected = await seed('9007199254741201', { mfa: true });
    await seed('103', { role: 'boardUser' });
    await seed('104', { disabled: true });
    await seed('105', { generation: randomUUID() });
    for (const sourceUserId of ['103', '104', '105', '106']) await assert.rejects(issue({ sourceUserId }), refuses);
    await assert.rejects(issue({ ...fallback }), refuses);
    await assert.rejects(issue({ runId: randomUUID(), sourceUserId: '101' }), refuses);
    assert.equal(await db.collection('recoveryGrants').countDocuments({}), 0);
    const original = await issue({ sourceUserId: '101' });
    assert.equal(original.userId, first.id);
    const retry = await issue({ sourceUserId: '101' });
    assert.deepEqual(retry, { status: 'already-issued', userId: first.id, expiresAt: original.expiresAt });
    const stored = await db.collection('recoveryGrants').findOne({ kind: 'migration-admin-recovery' });
    assert.equal(stored.tokenDigest, tokenDigest(original.grant));
    assert.ok(!JSON.stringify(stored).includes(original.grant));
    await assert.rejects(issue({ sourceUserId: '9007199254741201' }), refuses);
    fixture.setTime(new Date(original.expiresAt));
    await fixture.startGate();
    try { await assert.rejects(fixture.consume(original.grant), invalidGrant); }
    finally { await fixture.closeGate(); }
    const replacement = await issue({ sourceUserId: '9007199254741201' }, true);
    assert.equal(replacement.userId, selected.id);
    assert.notEqual(replacement.grant, original.grant);
    assert.equal(await db.collection('recoveryGrants').countDocuments({ kind: 'migration-admin-recovery', revokedAt: null }), 1);
    await fixture.startGate();
    const server = await fixture.startBrowser(origin);
    const call = (path, method = 'GET', body, otherHeaders = {}) => callSocket(server.path, path, {
      method, body, headers: { ...proxyHeaders(origin), origin, ...otherHeaders },
    });
    const recover = '/api/v1/recovery/consume';
    async function blocked() {
      for (const path of ['/health/ready', '/workspace', '/api/v1/projects', '/api/v1/attachments/fixture/download', '/api/v1/boards/fixture/events',
        '/sign-in', '/api/v1/session', '/oauth/consent', '/mcp']) assert.equal((await call(path)).status, 503, path);
    }
    try {
      assert.equal((await call('/account-recovery')).status, 200);
      assert.equal((await call('/recover')).status, 503);
      await blocked();
      assert.equal((await call(recover, 'POST', { grant: replacement.grant, password: stagedPassword }, { origin: 'https://wrong.test' })).status, 503);
      assert.equal((await call(recover, 'POST', { grant: original.grant, password: stagedPassword })).status, 400);
      const password = await call(recover, 'POST', { grant: replacement.grant, password: stagedPassword });
      assert.equal(password.status, 200, JSON.stringify(password.data));
      assert.equal(password.data.status, 'staged-enrollment-required');
      assert.equal(password.headers['set-cookie'], undefined);
      assert.equal(await readMigrationAdminActivationProof(db, run), null);
      await assert.rejects(fixture.consume(replacement.grant), invalidGrant);
      assert.equal((await call('/account-recovery')).status, 503);
      assert.equal((await call('/enroll-mfa')).status, 200);
      await blocked();
      const setup = await call('/api/v1/mfa/enrollment', 'POST', { enrollmentId: password.data.enrollmentId });
      assert.equal(setup.status, 200, JSON.stringify(setup.data));
      const totp = new TOTP({ secret: Secret.fromBase32(setup.data.secret), algorithm: 'SHA1', digits: 6, period: 30 });
      const approved = await call('/api/v1/mfa/enrollment/verify', 'POST', {
        enrollmentId: setup.data.enrollmentId, totpCode: totp.generate({ timestamp: now().valueOf() }),
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.data));
      assert.equal(approved.data.recoveryCodes.length, 10);
      assert.equal(approved.headers['set-cookie'], undefined);
      const proof = await readMigrationAdminActivationProof(db, run);
      assert.equal(proof.userId, selected.id);
      assert.equal(proof.accountRevision, 3);
      assert.equal(proof.credentialsVersion, 3);
      assert.ok(proof.factorId);
      assert.equal(await readMigrationAdminActivationProof(db, { ...run, fingerprint: { sha256: '9'.repeat(64) } }), null);
      const accounts = db.collection('users');
      assert.equal((await accounts.findOne(first)).localAuth.passwordVerifier, null);
      assert.equal((await accounts.findOne(selected)).role, 'admin');
      assert.equal(await fixture.hasher.verify('Synthetic prior source secret', (await accounts.findOne(selected)).localAuth.passwordVerifier), false);
      assert.equal(await db.collection('auditEntries').countDocuments({ action: 'migration.admin-password-recovered' }), 1);
      assert.equal(await db.collection('auditEntries').countDocuments({ action: 'mfa.enabled' }), 1);
      fixture.setTime(new Date(new Date(replacement.expiresAt).valueOf() + 1_000));
      assert.deepEqual(await readMigrationAdminActivationProof(db, run), proof);
      assert.equal((await call('/enroll-mfa')).status, 503);
      await blocked();
      await assertCold(db, scope);
    } finally { await server.close(); await fixture.closeGate(); }
  });
});

test('approved fallback stays local and preserves imported roles; a durable recovery claim is replayed once', { timeout: 40_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const fixture = await migrationAdminFixture(mongo);
    const { db, run, scope, seed, issue } = fixture;
    const disabled = await seed('101', { disabled: true });
    const member = await seed('102', { role: 'boardUser' });
    await assert.rejects(issue({ sourceUserId: '101' }), refuses);
    await assert.rejects(issue({ sourceUserId: '102' }), refuses);
    await assert.rejects(issue({ ...fallback, approveFallback: false }), refuses);
    await assert.rejects(issue({ ...fallback, email: '102@staged.example.test' }), refuses);
    const result = await issue(fallback);
    assert.notEqual(result.userId, disabled.id);
    assert.notEqual(result.userId, member.id);
    assert.equal((await issue(fallback)).grant, undefined);
    assert.equal(await db.collection('auditEntries').countDocuments({ action: 'migration.fallback-admin-approved' }), 1);
    assert.equal(await db.collection('importIds').countDocuments({ id: result.userId }), 0);
    await fixture.startGate();
    const interrupted = new Error('test interruption after the durable claim');
    try {
      await assert.rejects(fixture.consume(result.grant, async () => { throw interrupted; }), (error) => error === interrupted);
      assert.equal(await readMigrationAdminActivationProof(db, run), null);
    } finally { await fixture.closeGate(); }
    await fixture.startGate();
    try {
      await assert.rejects(fixture.consume(result.grant), invalidGrant);
      const account = await db.collection('users').findOne({ id: result.userId });
      assert.equal(account.localAuth.mfa, 'enrollment-required');
      assert.equal(account.revision, 2);
      assert.equal((await db.collection('users').findOne(member)).role, 'boardUser');
      assert.equal((await db.collection('users').findOne(disabled)).disabledAt instanceof Date, true);
      assert.equal(await db.collection('auditEntries').countDocuments({ action: 'migration.admin-password-recovered' }), 1);
      assert.equal(await db.collection('recoveryGrants').countDocuments({ claim: { $exists: true } }), 0);
      await assertCold(db, scope);
    } finally { await fixture.closeGate(); }
    const rotated = await issue(fallback, true);
    assert.equal(rotated.userId, result.userId);
    await fixture.startGate();
    try {
      const { enrollmentId } = await fixture.consume(rotated.grant);
      const setup = await fixture.mfa().begin({ enrollmentId });
      assert.ok(setup);
      const totp = new TOTP({ secret: Secret.fromBase32(setup.secret), algorithm: 'SHA1', digits: 6, period: 30 });
      assert.equal((await fixture.mfa().confirm({ enrollmentId }, totp.generate({ timestamp: fixture.now().valueOf() }))).recoveryCodes.length, 10);
      assert.equal((await readMigrationAdminActivationProof(db, run)).userId, result.userId);
      assert.equal(await db.collection('auditEntries').countDocuments({ action: 'migration.fallback-admin-approved' }), 1);
      await assertCold(db, scope);
    } finally { await fixture.closeGate(); }
  });
});

test('a selected imported administrator without source MFA completes password recovery without opening staging', { timeout: 25_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const fixture = await migrationAdminFixture(mongo);
    const user = await fixture.seed('101');
    const { grant } = await fixture.issue({ sourceUserId: '101' });
    await fixture.startGate();
    try {
      assert.deepEqual(await fixture.consume(grant), { status: 'confirmed' });
      const proof = await readMigrationAdminActivationProof(fixture.db, fixture.run);
      assert.deepEqual([proof.userId, proof.accountRevision, proof.credentialsVersion, proof.factorId], [user.id, 2, 2, null]);
      await assert.rejects(fixture.consume(grant), invalidGrant);
      await assertCold(fixture.db, fixture.scope);
    } finally { await fixture.closeGate(); }
    await assert.rejects(fixture.issue({ sourceUserId: '101' }, true), refuses);
  });
});

test('rotation preserves the authorized recovery while a durable MFA change is awaiting replay', { timeout: 30_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const fixture = await migrationAdminFixture(mongo);
    const member = await fixture.seed('101', { mfa: true });
    const { grant } = await fixture.issue({ sourceUserId: '101' });
    await fixture.startGate();
    try {
      const { enrollmentId } = await fixture.consume(grant);
      const setup = await fixture.mfa().begin({ enrollmentId });
      const totp = new TOTP({ secret: Secret.fromBase32(setup.secret), algorithm: 'SHA1', digits: 6, period: 30 });
      const original = fixture.db.collection;
      const interrupted = new Error('test interruption after the durable factor write');
      fixture.db.collection = function (name, ...args) {
        const collection = original.call(this, name, ...args);
        if (name === 'users') {
          const save = collection.findOneAndUpdate.bind(collection);
          collection.findOneAndUpdate = async (filter, update, ...options) => {
            const result = await save(filter, update, ...options);
            if (result && update.$set?.['localAuth.factorAudit']) throw interrupted;
            return result;
          };
        }
        return collection;
      };
      try {
        await assert.rejects(fixture.mfa().confirm({ enrollmentId }, totp.generate({ timestamp: fixture.now().valueOf() })),
          (error) => error === interrupted);
      } finally { fixture.db.collection = original; }
    } finally { await fixture.closeGate(); }
    const installation = await readInstallation(fixture.db, fixture.scope.installationId);
    const recovered = await fixture.db.collection('users').findOne(member);
    assert.ok(recovered.localAuth.factorAudit);
    assert.equal(await readMigrationAdminActivationProof(fixture.db, fixture.run), null);
    await assert.rejects(fixture.issue({ sourceUserId: '101' }, true), refuses);
    assert.deepEqual(await readInstallation(fixture.db, fixture.scope.installationId), installation);
    await fixture.startGate();
    try {
      const proof = await readMigrationAdminActivationProof(fixture.db, fixture.run);
      assert.equal(proof.userId, member.id);
      assert.equal(proof.factorId, recovered.localAuth.factor.id);
      assert.equal(await fixture.db.collection('auditEntries').countDocuments({ action: 'mfa.enabled' }), 1);
      await assertCold(fixture.db, fixture.scope);
    } finally { await fixture.closeGate(); }
  });
});
