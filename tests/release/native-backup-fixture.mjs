import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const release = '/opt/planner/current';
const moduleAt = (name) => import(`${release}/apps/backend/dist/${name}.js`);
const { BSON, Long } = createRequire(`${release}/apps/backend/package.json`)('mongodb');
const { acquireNativeWriter } = await moduleAt('native/writer');
const { connectConfiguredNativeMongo } = await moduleAt('native/mongo-readiness');
const { databaseName } = await moduleAt('native/mongo-identity');
const { readNativeMfaKey } = await moduleAt('native/mfa-key');
const { createPasswordHasher } = await moduleAt('application/auth/password');
const { defaultPreferences } = await moduleAt('application/auth/accounts');
const { createTotpSecret, issueRecoveryCodes } = await moduleAt('application/auth/mfa-crypto');
const { workspaceKey } = await moduleAt('storage/identity');
const fixed = (number) => `d9177751-573b-4159-9256-${number.toString(16).padStart(12, '0')}`;
const [project, board, list, card, enrollee, factor, other] = [1, 2, 3, 4, 5, 6, 9].map(fixed);
const password = 'Synthetic test password number 42';
const [, , action, expected] = process.argv;
const client = await connectConfiguredNativeMongo();
const db = client.db(databaseName);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let writer;
try {
  const installation = await db.collection('installation').findOne({ _id: 'installation' });
  const { installationId } = installation;
  if (action === 'seed') {
    writer = acquireNativeWriter();
    const generationId = installation.activeGenerationId;
    assert.ok(generationId);
    const admin = await db.collection('users').findOne({ generationId, role: 'admin' });
    assert.ok(admin);
    const mfaKey = readNativeMfaKey(installationId, process.getgid());
    const enrollment = createTotpSecret(mfaKey.key, { installationId, generationId, userId: enrollee, factorId: factor }, 'restore-fixture@example.test');
    const codes = issueRecoveryCodes();
    const now = new Date();
    const auth = { passwordVerifier: await createPasswordHasher().encode(password), credentialsVersion: 1, mfa: 'totp',
      factor: { id: factor, enrolledAt: now, encrypted: enrollment.encrypted, recoveryDigests: codes.digests, greatestCounter: 0 } };
    const rows = [
      ['projects', project, { name: 'Restorable project', ownerProjectManagerId: null, hidden: false, type: 'shared', rank: Long.fromNumber(1024) }],
      ['projectManagers', fixed(7), { projectId: project, userId: admin.id }],
      ['boards', board, { projectId: project, name: 'Restorable board', defaultView: 'kanban', rank: Long.fromNumber(1024), orderVersion: 1 }],
      ['boardMembers', fixed(8), { boardId: board, userId: admin.id, role: 'editor', canComment: null }],
      ['lists', list, { boardId: board, kind: 'active', rank: Long.fromNumber(1024), name: 'To do', orderVersion: 1 }],
      ['cards', card, { boardId: board, listId: list, type: 'project', kind: 'board', name: 'Restorable card', rank: Long.fromBigInt(9223372036854775807n) }],
      ['users', enrollee, { role: 'boardUser', name: 'Retained MFA user', normalizedEmail: 'restore-fixture@example.test', email: 'restore-fixture@example.test',
        username: null, normalizedUsername: null, disabledAt: null, preferences: defaultPreferences, localAuth: auth }],
    ];
    for (const [collection, id, fields] of rows) await db.collection(collection).insertOne({ _id: workspaceKey(generationId, id),
      id, generationId, revision: 1, createdAt: now, updatedAt: null, ...fields }, { writeConcern: { w: 1, j: true } });
    await db.collection('cards').insertOne({ _id: workspaceKey(other, card), id: card, generationId: other, boardId: board,
      listId: list, type: 'project', kind: 'board', name: 'Other generation has opposite label', revision: 1, createdAt: now,
      rank: Long.fromBigInt(-9223372036854775808n) }, { writeConcern: { w: 1, j: true } });
    // Synthetic proof parts stay on the private transfer medium and out of the serial log.
    process.stdout.write(JSON.stringify({ installationId, generationId, card, admin: admin.id, mfaSecret: enrollment.secret }));
  } else {
    const input = JSON.parse(await readFile(expected, 'utf8'));
    assert.equal(installationId, input.installationId);
    const staged = action === 'staged';
    assert.equal(installation.activeGenerationId, staged ? null : input.generationId);
    assert.equal(installation.restoration.phase, staged ? 'staged' : 'active');
    const raw = await db.collection('cards').findOne({ _id: workspaceKey(input.generationId, card) }, { raw: true });
    assert.ok(raw);
    assert.equal(BSON.deserialize(raw, { promoteLongs: false }).rank.toBigInt(), 9223372036854775807n);
    const inactive = await db.collection('cards').findOne({ _id: workspaceKey(other, card) }, { promoteLongs: false });
    assert.equal(inactive.rank.toBigInt(), -9223372036854775808n);
    assert.equal((await db.collection('users').findOne({ _id: workspaceKey(input.generationId, input.admin) })).id, input.admin);
    const result = await db.collection('attachments').findOne({ _id: workspaceKey(input.generationId, input.attachmentId) });
    assert.equal(result.blobDigest, input.fileSha);
    assert.equal(digest(await readFile(`/var/lib/planner/blobs/${input.fileSha}`)), input.fileSha);
    if (staged) {
      for (const name of ['sessions', 'trustedDevices', 'recoveryGrants', 'oauthArtifacts']) assert.equal(await db.collection(name).countDocuments(), 0);
    }
  }
} finally { writer?.release(); await client.close(); }
