import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [action, ticketFile] = process.argv.slice(2);
const release = 'file:///opt/planner/current/apps/backend/dist/';
const load = (file) => import(new URL(file, release));
const { acquireNativeWriter } = await load('native/writer.js');
const { connectVerifiedNativeMongo } = await load('native/mongo-readiness.js');
const { workspaceKey } = await load('storage/identity.js');
const { defaultPreferences } = await load('application/auth/accounts.js');
const { createPasswordHasher } = await load('application/auth/password.js');
const { issueStagedMfaTicket } = await load('application/auth/mfa-management.js');
const { getFactor } = await load('application/auth/mfa-account.js');
const { newToken, tokenDigest } = await load('application/auth/credentials.js');
const credential = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const lease = acquireNativeWriter();
const client = await connectVerifiedNativeMongo(credential);
try {
  const { installationId } = credential;
  const db = client.db('planner');
  const installation = db.collection('installation');
  const settings = await installation.findOne({ _id: 'installation', installationId });
  assert.equal(settings.activeGenerationId, null);
  assert.equal(settings.setup.mode, 'import');
  assert.equal(settings.setup.pendingAction, 'migration-preflight');
  const durable = { writeConcern: { w: 1, j: true } };
  if (action === 'prepare') {
    assert.equal(settings.setup.enrollmentGenerationId, null);
    const generationId = randomUUID();
    const userId = randomUUID();
    const recoveryId = randomUUID();
    const time = new Date();
    const verifier = await createPasswordHasher().encode('Synthetic staged password with space');
    await db.collection('users').insertOne({
      _id: workspaceKey(generationId, userId), id: userId, generationId, revision: 1, normalizedEmail: 'staged@example.test',
      email: 'staged@example.test', name: 'Staged Admin', username: null, normalizedUsername: null, role: 'admin',
      disabledAt: null, createdAt: time, preferences: defaultPreferences, requiresMfaEnrollment: true,
      localAuth: { passwordVerifier: verifier, credentialsVersion: 2, mfa: 'enrollment-required' },
    }, durable);
    await db.collection('recoveryGrants').insertOne({
      _id: workspaceKey(generationId, recoveryId), id: recoveryId, userId, generationId, installationId,
      kind: 'account-recovery', targetEpoch: 1, tokenDigest: tokenDigest(newToken()), actorId: userId, actorEpoch: 1,
      issuedAt: new Date(time - 10_000), expiresAt: new Date(Number(time) + 30 * 60_000 - 10_000), consumedAt: time, revokedAt: null,
    }, durable);
    const saved = await installation.updateOne({ _id: 'installation', installationId, activeGenerationId: { $type: 'null' } },
      { $set: { 'setup.enrollmentGenerationId': generationId, 'setup.stagedMfaEnrollment': { userId, recoveryId, credentialsVersion: 2 } } }, durable);
    assert.equal(saved.matchedCount, 1);
    const ticket = await issueStagedMfaTicket(db, installationId, new Date());
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/u);
    await writeFile(ticketFile, ticket + '\n', { mode: 0o600 });
  } else if (action === 'verify') {
    const { userId } = settings.setup.stagedMfaEnrollment;
    const generationId = settings.setup.enrollmentGenerationId;
    const user = await db.collection('users').findOne({ _id: workspaceKey(generationId, userId), generationId });
    assert.equal(user.id, userId);
    assert.equal(user.role, 'admin');
    assert.equal(user.requiresMfaEnrollment, false);
    assert.equal(user.localAuth.credentialsVersion, 3);
    assert.equal(user.localAuth.mfa, 'totp');
    assert.ok(getFactor(user));
    assert.equal(await db.collection('sessions').countDocuments({}), 0);
    assert.equal(await db.collection('trustedDevices').countDocuments({}), 0);
    assert.equal(await db.collection('auditEntries').countDocuments({ generationId, actorId: userId, action: 'mfa.enabled' }), 1);
  } else throw new Error('Expected a staged MFA fixture command.');
} finally {
  await client.close();
  lease.release();
}
