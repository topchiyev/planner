import assert from 'node:assert/strict';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Secret, TOTP } from 'otpauth';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { adminAccountOf, requireSiteAdmin, usableAdmin } from '../../apps/backend/dist/application/auth/account-policy.js';
import { defaultPreferences } from '../../apps/backend/dist/application/auth/accounts.js';
import { newToken, tokenDigest } from '../../apps/backend/dist/application/auth/credentials.js';
import { getFactor, readStagedMfaEnrollment, recoverFactorChanges } from '../../apps/backend/dist/application/auth/mfa-account.js';
import { factorStepMs } from '../../apps/backend/dist/application/auth/mfa-crypto.js';
import { beginPasswordMfa, verifyPasswordMfa } from '../../apps/backend/dist/application/auth/mfa-login.js';
import { createMfaManagement, issueStagedMfaTicket } from '../../apps/backend/dist/application/auth/mfa-management.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema, readInstallation } from '../../apps/backend/dist/storage/schema.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';

const password = 'Synthetic MFA password with space';
const verifier = { version: 'scrypt-v1', salt: '1'.repeat(32), key: '2'.repeat(64) };
const hasher = { encode: async () => verifier, verify: async (candidate, actual) => candidate === password && !!actual };
const initial = new Date('2026-03-19T13:13:59.719Z');

async function setup({ db, directory }, staged = false) {
  const installationId = randomUUID();
  const generationId = randomUUID();
  const userId = randomUUID();
  const recoveryId = randomUUID();
  const users = db.collection('users');
  const grants = db.collection('recoveryGrants');
  const installation = db.collection('installation');
  await installation.insertOne({
    _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: staged ? null : generationId,
    setup: staged ? { mode: 'import', pendingAction: 'migration-preflight', enrollmentGenerationId: generationId,
      stagedMfaEnrollment: { userId, recoveryId, accountRevision: 3, credentialsVersion: 2 } }
      : { mode: 'fresh', pendingAction: 'complete', enrollmentGenerationId: generationId },
  });
  const user = {
    _id: workspaceKey(generationId, userId), id: userId, generationId, revision: staged ? 3 : 1,
    name: 'Synthetic MFA account', email: 'mfa@example.test', normalizedEmail: 'mfa@example.test', username: null, normalizedUsername: null,
    role: 'admin', disabledAt: null, createdAt: initial, preferences: defaultPreferences,
    requiresMfaEnrollment: staged,
    localAuth: { passwordVerifier: verifier, credentialsVersion: staged ? 2 : 1, mfa: staged ? 'enrollment-required' : 'none' },
  };
  await users.insertOne(user);
  if (staged) {
    await grants.insertOne({
      _id: workspaceKey(generationId, recoveryId), id: recoveryId, userId, generationId, installationId,
      kind: 'account-recovery', targetEpoch: 1, targetRevision: 2, actorId: userId, actorEpoch: 0, tokenDigest: tokenDigest(newToken()),
      issuedAt: new Date(initial.getTime() - 60_000), expiresAt: new Date(initial.getTime() + 29 * 60_000),
      consumedAt: new Date(initial.getTime() - 1_000), revokedAt: null,
    });
  }
  await migrateStorageSchema(db, installationId);
  const writer = join(directory, 'writer');
  await mkdir(writer);
  await chmod(writer, 0o750);
  const owner = { uid: process.getuid(), gid: process.getgid() };
  const gate = new CommandGate(acquireWriterDirectory(writer, owner, owner));
  await gate.recover(() => recoverFactorChanges(db, installationId));
  const key = createSecretKey(randomBytes(32));
  let time = initial;
  const now = () => time;
  const manage = createMfaManagement(db, installationId, gate, key, hasher, now);
  const sessions = createBrowserSessions(db, installationId, gate, hasher, now, key);
  return {
    installationId, generationId, userId, recoveryId, users, grants, installation, gate, key, manage, sessions, now,
    setTime: (value) => { time = value; }, user: () => users.findOne({ _id: user._id }),
  };
}

function totpFrom(secret) {
  return new TOTP({ secret: Secret.fromBase32(secret), issuer: 'Planner', algorithm: 'SHA1', digits: 6, period: 30 });
}

test('standalone Mongo atomically binds factor changes, consumes challenge and factor separately, and expires device trust', { timeout: 35_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const { db } = mongo;
    const fixture = await setup(mongo);
    const { gate, manage, sessions, key, installationId, generationId, grants, now } = fixture;
    const passwordStep = async (device) => gate.runCommand(async () => beginPasswordMfa(db, installationId, await fixture.user(), now(), device));
    const verify = (proof) => gate.runCommand(() => verifyPasswordMfa(db, installationId, generationId, key, proof, now()));
    try {
      const first = await sessions.login({ identifier: 'mfa@example.test', password });
      assert.equal(first.status, 'authenticated');
      assert.deepEqual(await manage.list(first.token), { mfaEnabled: false, devices: [] });
      const own = { _id: workspaceKey(generationId, fixture.userId) };
      await fixture.users.updateOne(own, { $set: { 'localAuth.factor': {} } });
      assert.equal((await sessions.login({ identifier: 'mfa@example.test', password })).status, 'invalid');
      assert.equal(await sessions.read(first.token), null);
      const contradictory = await fixture.user();
      assert.equal(usableAdmin(contradictory), false);
      assert.notEqual(adminAccountOf(contradictory).signIn, 'available');
      await fixture.users.updateOne(own, { $unset: { 'localAuth.factor': '' }, $set: { revision: Number.MAX_SAFE_INTEGER } });
      assert.equal(await manage.begin({ sessionToken: first.token }), null);
      assert.equal(gate.ready, true);
      assert.equal(await grants.countDocuments({ kind: 'mfa-enrollment' }), 0);
      await fixture.users.updateOne(own, { $set: { revision: 1 } });
      const enrolled = await manage.begin({ sessionToken: first.token });
      assert.ok(enrolled);
      const totp = totpFrom(enrolled.secret);
      const codeAt = () => totp.generate({ timestamp: now().getTime() });
      assert.equal(await manage.begin({ enrollmentId: enrolled.enrollmentId, sessionToken: first.token }), null);
      assert.equal(await manage.confirm({ enrollmentId: enrolled.enrollmentId }, codeAt()), null);
      const issued = await manage.confirm({ enrollmentId: enrolled.enrollmentId, sessionToken: first.token }, codeAt());
      assert.equal(issued.recoveryCodes.length, 10);
      assert.equal(await sessions.read(first.token), null);
      const stored = await fixture.user();
      assert.equal(usableAdmin(stored), true);
      assert.equal(adminAccountOf(stored).signIn, 'available');
      assert.doesNotThrow(() => requireSiteAdmin(stored));
      assert.equal(stored.localAuth.credentialsVersion, 2);
      assert.equal(stored.localAuth.mfa, 'totp');
      const factor = getFactor(stored);
      const state = JSON.stringify({ factor, audit: await db.collection('auditEntries').find().toArray() });
      for (const secret of [enrolled.secret, enrolled.uri, ...issued.recoveryCodes]) assert.equal(state.includes(secret), false);
      for (const code of issued.recoveryCodes) assert.equal(factor.recoveryDigests.includes(tokenDigest(code)), true);

      const later = new Date(now().getTime() + factorStepMs);
      fixture.setTime(later);
      const earlier = await passwordStep();
      const rival = await passwordStep();
      assert.equal(earlier.status, 'challenge-required');
      assert.equal(rival.status, 'challenge-required');
      const code = codeAt();
      const accepted = await sessions.verifyMfa({ challengeId: earlier.challengeId, totpCode: code, rememberDevice: true });
      assert.equal(accepted.session.account.id, fixture.userId);
      assert.equal((await sessions.read(accepted.token)).account.role, 'admin');
      assert.equal(typeof accepted.trustedToken, 'string');
      assert.equal(await verify({ challengeId: earlier.challengeId, recoveryCode: issued.recoveryCodes[0] }), null);
      assert.equal(await verify({ challengeId: rival.challengeId, totpCode: code }), null);
      assert.ok(await verify({ challengeId: rival.challengeId, recoveryCode: issued.recoveryCodes[0] }));
      const another = await passwordStep();
      assert.equal(await verify({ challengeId: another.challengeId, recoveryCode: issued.recoveryCodes[0] }), null);
      const expired = await passwordStep();
      fixture.setTime(new Date(now().getTime() + 5 * 60_000));
      assert.equal(await verify({ challengeId: expired.challengeId, recoveryCode: issued.recoveryCodes[1] }), null);
      assert.equal((await passwordStep(accepted.trustedToken)).status, 'passed');

      const limited = await passwordStep();
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal(await verify({ challengeId: limited.challengeId, recoveryCode: newToken() }), null);
      }
      assert.equal(await verify({ challengeId: limited.challengeId, recoveryCode: issued.recoveryCodes[1] }), null);
      const raw = await grants.findOne({ tokenDigest: tokenDigest(limited.challengeId) });
      assert.equal(raw.attempts, 5);
      assert.equal(JSON.stringify(raw).includes(limited.challengeId), false);
      const device = await db.collection('trustedDevices').findOne({});
      assert.equal(device.tokenDigest, tokenDigest(accepted.trustedToken));
      assert.equal(JSON.stringify(device).includes(accepted.trustedToken), false);
      const devices = await manage.list(accepted.token, accepted.trustedToken);
      assert.equal(devices.mfaEnabled, true);
      assert.equal(devices.devices.length, 1);
      assert.equal(devices.devices[0].current, true);
      fixture.setTime(device.expiresAt);
      assert.equal((await passwordStep(accepted.trustedToken)).status, 'challenge-required');
    } finally { await gate.closeAndDrain(); }
  });
});

test('only the exact recovered staged administrator can enroll and completion leaves storage inactive', { timeout: 30_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const { db } = mongo;
    const fixture = await setup(mongo, true);
    const { installationId, generationId, userId, recoveryId, gate, manage, sessions, now, grants, users, installation } = fixture;
    const issue = () => gate.runCommand(() => issueStagedMfaTicket(db, installationId, now()));
    try {
      assert.equal((await sessions.login({ identifier: 'mfa@example.test', password })).status, 'invalid');
      assert.equal(usableAdmin(await fixture.user()), false);
      assert.equal(await manage.begin({ enrollmentId: newToken() }), null);
      const ticket = await issue();
      assert.equal(typeof ticket, 'string');
      await installation.updateOne({}, { $set: { 'setup.stagedMfaEnrollment.recoveryId': randomUUID() } });
      assert.equal(await manage.begin({ enrollmentId: ticket }), null);
      assert.equal(await readStagedMfaEnrollment(db, installationId, now()), null);
      await installation.updateOne({}, { $set: { 'setup.stagedMfaEnrollment.recoveryId': recoveryId } });
      const grantId = { _id: workspaceKey(generationId, recoveryId) };
      const recovered = await grants.findOne(grantId);
      assert.ok(recovered);
      await grants.updateOne(grantId, { $unset: { targetRevision: '' } });
      assert.equal(await readStagedMfaEnrollment(db, installationId, now()), null);
      await grants.updateOne(grantId, { $set: { targetRevision: 2, actorId: randomUUID() } });
      assert.equal(await manage.begin({ enrollmentId: ticket }), null);
      await grants.updateOne(grantId, { $set: { actorId: userId, userId: randomUUID() } });
      assert.equal(await manage.begin({ enrollmentId: ticket }), null);
      await grants.updateOne(grantId, { $set: { userId, tokenDigest: 'invalid' } });
      assert.equal(await manage.begin({ enrollmentId: ticket }), null);
      await grants.replaceOne(grantId, recovered);
      const accountId = { _id: workspaceKey(generationId, userId) };
      await users.updateOne(accountId, { $set: { revision: 4 } });
      assert.equal(await manage.begin({ enrollmentId: ticket }), null);
      await users.updateOne(accountId, { $set: { revision: 3 } });
      const enrollment = await manage.begin({ enrollmentId: ticket });
      assert.ok(enrollment);
      assert.equal(await manage.begin({ enrollmentId: ticket }), null);
      const code = totpFrom(enrollment.secret).generate({ timestamp: now().getTime() });
      assert.equal((await manage.confirm({ enrollmentId: ticket }, code)).recoveryCodes.length, 10);
      assert.equal(await manage.confirm({ enrollmentId: ticket }, code), null);
      assert.equal(await issue(), null);
      const saved = await fixture.user();
      assert.equal(saved.id, userId);
      assert.equal(saved.generationId, generationId);
      assert.equal(saved.requiresMfaEnrollment, false);
      assert.ok(getFactor(saved));
      assert.equal((await readInstallation(db, installationId)).activeGenerationId, null);
      assert.equal((await sessions.login({ identifier: 'mfa@example.test', password })).status, 'invalid');
      assert.equal(await db.collection('sessions').countDocuments({}), 0);
    } finally { await gate.closeAndDrain(); }
  });
});


test('staged replay accepts only the completed scoped enrollment, even after its proof expired', { timeout: 30_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const { db } = mongo;
    const fixture = await setup(mongo, true);
    const { installationId, generationId, gate, key, now, users, manage, userId } = fixture;
    const userKey = { _id: workspaceKey(generationId, userId) };
    const interruption = new Error('test audit write interruption');
    const failingDb = {
      collection: (name) => name === 'auditEntries' ? { insertOne: async () => { throw interruption; } } : db.collection(name),
    };
    const failing = createMfaManagement(failingDb, installationId, gate, key, hasher, now);
    try {
      const ticket = await gate.runCommand(() => issueStagedMfaTicket(db, installationId, now()));
      const enrollment = await manage.begin({ enrollmentId: ticket });
      const code = totpFrom(enrollment.secret).generate({ timestamp: now().getTime() });
      await assert.rejects(() => failing.confirm({ enrollmentId: ticket }, code), interruption);
      assert.equal(gate.state, 'maintenance');
      const committedState = await fixture.user();
      assert.equal(committedState.localAuth.factorAudit.action, 'enabled');
      fixture.setTime(new Date(now().getTime() + 31 * 60_000));

      const unrelatedId = randomUUID();
      const unrelated = { ...committedState, _id: workspaceKey(generationId, unrelatedId), id: unrelatedId,
        normalizedEmail: 'unrelated@example.test' };
      await users.updateOne(userKey, { $unset: { 'localAuth.factorAudit': '' } });
      await users.insertOne(unrelated);
      const resume = () => gate.recover(() => recoverFactorChanges(db, installationId));
      await assert.rejects(resume, /does not match the authorized recovery/u);
      assert.equal(await db.collection('auditEntries').countDocuments({}), 0);
      await users.deleteOne({ _id: unrelated._id });
      await users.replaceOne(userKey, committedState);
      await users.updateOne(userKey, { $set: { 'localAuth.factorAudit.action': 'recovery-codes-renewed' } });
      await assert.rejects(resume, /does not match the authorized recovery/u);
      assert.equal(await db.collection('auditEntries').countDocuments({}), 0);

      await users.replaceOne(userKey, committedState);
      await resume();
      assert.equal((await fixture.user()).localAuth.factorAudit, undefined);
      assert.equal(await db.collection('auditEntries').countDocuments({ generationId, actorId: userId, action: 'mfa.enabled' }), 1);
      assert.equal((await readInstallation(db, installationId)).activeGenerationId, null);
    } finally { await gate.closeAndDrain(); }
  });
});

test('malformed protected factor audit state refuses replay before credential or audit effects', { timeout: 25_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const { db } = mongo;
    const fixture = await setup(mongo);
    const { userId, generationId, gate, sessions, users, installationId, now } = fixture;
    const accountId = { _id: workspaceKey(generationId, userId) };
    const record = await fixture.user();
    try {
      const login = await sessions.login({ identifier: 'mfa@example.test', password });
      assert.equal(login.status, 'authenticated');
      const marker = {
        id: randomUUID(), revision: record.revision, credentialsVersion: record.localAuth.credentialsVersion,
        action: 'disabled', time: now(),
      };
      await assert.rejects(() => gate.runCommand(() => { throw new Error('test interruption'); }));
      for (const invalid of [
        { id: randomUUID() }, { disabledAt: now() }, { requiresMfaEnrollment: true },
        { 'localAuth.credentialsVersion': -1, 'localAuth.factorAudit.credentialsVersion': -1 },
      ]) {
        await users.replaceOne(accountId, record);
        await users.updateOne(accountId, { $set: { 'localAuth.factorAudit': marker } });
        await users.updateOne(accountId, { $set: invalid });
        await assert.rejects(() => gate.recover(() => recoverFactorChanges(db, installationId)), /invalid multifactor transition/u);
        assert.equal((await db.collection('sessions').findOne({})).revokedAt, null);
        assert.equal(await db.collection('auditEntries').countDocuments({}), 0);
      }
      await users.replaceOne(accountId, record);
      await gate.recover(() => recoverFactorChanges(db, installationId));
      assert.ok(await sessions.read(login.token));
    } finally { await gate.closeAndDrain(); }
  });
});
