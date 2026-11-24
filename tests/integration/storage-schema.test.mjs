import assert from 'node:assert/strict';
import test from 'node:test';
import { Double, Long } from 'mongodb';
import {
  compareHistory, comparePlacement, decodeRank, encodeRank, legacyPublicId, newPublicId, workspaceKey,
} from '../../apps/backend/dist/storage/identity.js';
import { ownedIndexes, workspaceCollections } from '../../apps/backend/dist/storage/catalog.js';
import {
  currentStorageSchema, migrateStorageSchema, verifyStorageSchema,
} from '../../apps/backend/dist/storage/schema.js';
import { openActiveWorkspace, openTrustedStagedWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { publicIdSchema, rankSpacing, signedInt64TextSchema } from '../../packages/contracts/src/storage.ts';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);

const installationId = 'c2dc0286-8ca0-482b-8d16-90d989f938ac';
const activeGenerationId = '2e91e11b-8a3d-4134-a569-6139cf555708';
const stagedGenerationId = 'f7d50ef1-dfcc-4a80-aa75-bc6bb3784212';
const usedId = 'c8fbb819-a78a-4a09-8f91-8ad08c730e7c';
const higherId = 'd8fbb819-a78a-4a09-8f91-8ad08c730e7c';
const createdAt = new Date('2026-03-19T13:13:59.719Z');
const expiresAt = new Date('2026-03-19T13:43:59.719Z');
const lostPower = new Error('simulated interruption');

function olderInstallation(overrides = {}) {
  return {
    _id: 'installation', installationId, schemaVersion: 0, activeGenerationId,
    setup: {
      mode: 'fresh', pendingAction: 'first-admin-enrollment',
      enrollmentGenerationId: stagedGenerationId, firstAdminGrantIssuedAt: createdAt,
    },
    rollbackFence: null,
    ...overrides,
  };
}

function olderGrant() {
  return {
    _id: usedId, installationId, generationId: stagedGenerationId, kind: 'first-admin',
    tokenDigest: 'a'.repeat(64), issuedAt: createdAt, expiresAt, consumedAt: null,
  };
}

function rejectDuplicate(operation) {
  return assert.rejects(operation, (error) => error?.code === 11_000);
}

test('public UUID, int64 and UTC ordering preserve exact source values', () => {
  const namespace = '11111111-2222-4333-8444-555555555555';
  assert.equal(legacyPublicId(namespace, 'card', '9007199254740992'), '8d24e457-5c7d-523f-ad55-737610a4cafa');
  assert.equal(legacyPublicId(namespace, 'card', '9007199254740993'), 'eb220104-0a49-50da-ab41-70a10761195b');
  const fileId = '03000000-0000-4000-8000-000000000001';
  assert.equal(legacyPublicId(namespace, 'uploaded_file', fileId), 'ed68ec9b-86d0-518c-a52e-fcab3cc61482');
  assert.equal(legacyPublicId(namespace, 'attachment', '9007199254740993'), '8b29b745-104d-5828-be37-68683f19a160');
  assert.throws(() => legacyPublicId(namespace, 'card', fileId));
  assert.throws(() => legacyPublicId(namespace, 'attachment', fileId));
  assert.throws(() => legacyPublicId(namespace, 'attachment', '/some/path'));
  assert.throws(() => legacyPublicId(namespace, 'card', '09007199254740993'));
  assert.match(newPublicId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(publicIdSchema.safeParse('00000000-0000-0000-0000-000000000000').success, false);
  assert.equal(workspaceKey(activeGenerationId, usedId), `${activeGenerationId}/${usedId}`);
  assert.throws(() => workspaceKey('foreign', usedId));
  assert.equal(rankSpacing, 1024n);
  for (const exact of [-9223372036854775808n, -9007199254740993n, -9007199254740992n,
    -1n, 0n, 1n, 9007199254740992n, 9007199254740993n, 9223372036854775807n]) {
    assert.equal(decodeRank(encodeRank(exact)), exact);
    assert.equal(encodeRank(exact.toString()).toString(), exact.toString());
  }
  for (const invalid of ['-0', '01', '+1', '9223372036854775808', '-9223372036854775809', '1e10']) {
    assert.equal(signedInt64TextSchema.safeParse(invalid).success, false);
    assert.throws(() => encodeRank(invalid));
  }
  assert.throws(() => encodeRank(9007199254740992));
  assert.throws(() => decodeRank(Long.fromBigInt(1n, true)));
  const sameRank = encodeRank('9007199254740993');
  assert.ok(comparePlacement({ id: usedId, rank: sameRank }, { id: higherId, rank: sameRank }) < 0);
  assert.ok(compareHistory({ id: usedId, listChangedAt: createdAt, historySequence: sameRank },
    { id: higherId, listChangedAt: createdAt, historySequence: sameRank }) > 0);
});

test('owned standalone storage resumes canonical copy and index publication without changing existing values', { timeout: 35_000 }, async () => {
  await withFixtureMongo(async ({ db }) => {
    const installation = db.collection('installation');
    const grants = db.collection('recoveryGrants');
    await installation.insertOne(olderInstallation());
    await grants.insertOne(olderGrant());
    const project = {
      _id: workspaceKey(activeGenerationId, usedId), id: usedId, generationId: activeGenerationId,
      revision: 3, rank: encodeRank('9007199254740993'), createdAt, updatedAt: null, displayName: 'Original project',
    };
    await db.collection('projects').insertOne(project);
    await assert.rejects(verifyStorageSchema(db, installationId), { code: 'version' });
    await assert.rejects(migrateStorageSchema(db, installationId, {
      afterLegacyGrantCopy: async () => { throw lostPower; },
    }), lostPower);
    assert.equal((await installation.findOne({})).schemaMigration.phase, 'records');
    const canonical = { ...olderGrant(), id: usedId, _id: workspaceKey(stagedGenerationId, usedId) };
    assert.deepEqual(await grants.findOne({ _id: canonical._id }), canonical);
    assert.deepEqual(await grants.findOne({ _id: usedId }), olderGrant());

    await assert.rejects(migrateStorageSchema(db, installationId, {
      beforeVersionPublication: async () => { throw lostPower; },
    }), lostPower);
    const pending = await installation.findOne({});
    assert.equal(pending.schemaVersion, 0);
    assert.equal(pending.schemaMigration.phase, 'verified');
    await assert.rejects(verifyStorageSchema(db, installationId), { code: 'version' });
    assert.deepEqual(await grants.findOne({}), canonical);
    assert.equal(await grants.countDocuments(), 1);
    assert.deepEqual(await db.collection('projects').findOne({}, { promoteLongs: false }), project);

    const migrated = await migrateStorageSchema(db, installationId);
    assert.deepEqual(migrated, olderInstallation({ schemaVersion: currentStorageSchema }));
    assert.deepEqual(await migrateStorageSchema(db, installationId), migrated);
    assert.deepEqual(await verifyStorageSchema(db, installationId), migrated);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name).sort();
    assert.equal(workspaceCollections.length, 37);
    assert.deepEqual(names, ['installation', ...workspaceCollections].sort());
    for (const name of workspaceCollections) {
      const actual = await db.collection(name).listIndexes().toArray();
      assert.equal(actual.length, ownedIndexes(name).length + 1);
      for (const expected of ownedIndexes(name)) {
        const index = actual.find(({ name }) => name === expected.name);
        assert.deepEqual(Object.entries(index.key), expected.keys);
        assert.equal(index.unique, expected.unique);
        assert.deepEqual(index.partialFilterExpression, expected.partialFilterExpression);
      }
    }
    // Verify a manually drifted catalog fails closed and remains untouched.
    await db.collection('boardMembers').dropIndex('board_user');
    await assert.rejects(verifyStorageSchema(db, installationId), { code: 'catalog' });
    await assert.rejects(migrateStorageSchema(db, installationId), { code: 'catalog' });
    assert.equal(await db.collection('boardMembers').indexExists('board_user'), false);
  });
});

test('unknown identity, newer schema and incompatible legacy or index data fail closed', { timeout: 25_000 }, async () => {
  await withFixtureMongo(async ({ db }) => {
    const installation = db.collection('installation');
    const grants = db.collection('recoveryGrants');
    await installation.insertOne(olderInstallation({ schemaVersion: 99 }));
    await assert.rejects(migrateStorageSchema(db, newPublicId()), { code: 'identity' });
    await assert.rejects(verifyStorageSchema(db, installationId), { code: 'version' });
    await assert.rejects(migrateStorageSchema(db, installationId), { code: 'version' });
    assert.equal((await installation.findOne({})).schemaVersion, 99);
    assert.equal((await db.listCollections().toArray()).length, 1);
    await installation.updateOne({ _id: 'installation' }, { $set: { schemaVersion: 0 } });
    await db.collection('projects').createIndex({ generationId: 1, rank: -1 }, { name: 'placement' });
    await assert.rejects(migrateStorageSchema(db, installationId), { code: 'catalog' });
    assert.equal((await installation.findOne({})).schemaVersion, 0);
    assert.deepEqual((await db.collection('projects').listIndexes().toArray()).find(({ name }) => name === 'placement').key,
      { generationId: 1, rank: -1 });
    await db.collection('projects').dropIndex('placement');
    const conflicting = {
      ...olderGrant(), id: usedId, _id: workspaceKey(stagedGenerationId, usedId), tokenDigest: 'b'.repeat(64),
    };
    await grants.insertMany([olderGrant(), conflicting]);
    await assert.rejects(migrateStorageSchema(db, installationId),
      (error) => error.code === 'records' && /conflicts/u.test(error.message));
    assert.deepEqual(await grants.findOne({ _id: usedId }), olderGrant());
    assert.deepEqual(await grants.findOne({ _id: conflicting._id }), conflicting);
    assert.equal((await installation.findOne({})).schemaVersion, 0);
    await assert.rejects(verifyStorageSchema(db, installationId), { code: 'version' });
  });
});

test('legacy numeric rank and sequence BSON must be Long before schema publication', { timeout: 30_000 }, async () => {
  await withFixtureMongo(async ({ db }) => {
    const installation = db.collection('installation');
    await installation.insertOne(olderInstallation());
    const list = { _id: workspaceKey(activeGenerationId, higherId), id: higherId,
      generationId: activeGenerationId, boardId: usedId, kind: 'archive', rank: null };
    await db.collection('lists').insertOne(list);
    for (const [collectionName, field, invalid] of [
      ['projects', 'rank', new Double(1.5)],
      ['cards', 'historySequence', new Double(1)],
      ['commands', 'recoverySequence', 1],
      ['events', 'sequence', '9007199254740993'],
    ]) {
      const collection = db.collection(collectionName);
      const row = { _id: workspaceKey(activeGenerationId, usedId), id: usedId, generationId: activeGenerationId };
      await collection.insertOne({ ...row, [field]: invalid });
      await assert.rejects(migrateStorageSchema(db, installationId),
        (error) => error.code === 'records' && /signed BSON Long/u.test(error.message));
      assert.equal((await installation.findOne({})).schemaVersion, 0);
      assert.equal((await installation.findOne({})).schemaMigration.phase, 'indexes');
      await collection.deleteOne({ _id: row._id });
    }
    const rawProject = { _id: workspaceKey(activeGenerationId, usedId), id: usedId, generationId: activeGenerationId };
    const projects = db.collection('projects');
    await projects.insertOne({ ...rawProject, createdAt: createdAt.toISOString() });
    await assert.rejects(migrateStorageSchema(db, installationId), /BSON Date/u);
    await projects.updateOne({ _id: rawProject._id }, { $set: { createdAt, revision: 0 } });
    await assert.rejects(migrateStorageSchema(db, installationId), /revision is invalid/u);
    await projects.updateOne({ _id: rawProject._id }, { $set: { revision: 1 } });
    await migrateStorageSchema(db, installationId);
    assert.deepEqual(await db.collection('lists').findOne({}), list);
  });
});

test('verified active and privileged staged stores isolate reads, writes and generation-first uniqueness', { timeout: 35_000 }, async () => {
  await withFixtureMongo(async ({ db }) => {
    await db.collection('installation').insertOne(olderInstallation());
    await migrateStorageSchema(db, installationId);
    const active = await openActiveWorkspace(db, installationId);
    const staged = await openTrustedStagedWorkspace(db, installationId, stagedGenerationId);
    await assert.rejects(openTrustedStagedWorkspace(db, installationId, activeGenerationId));
    assert.equal(active.generationId, activeGenerationId);
    assert.equal(staged.generationId, stagedGenerationId);
    await assert.rejects(active.insert('projects', usedId, { generationId: stagedGenerationId }));
    await assert.rejects(active.insert('projects', usedId, { _id: 'malicious' }));
    await assert.rejects(active.insert('projects', usedId, { rank: 9007199254740993 }));
    await assert.rejects(active.insert('projects', usedId, { createdAt: '2026-03-19T13:13:59' }));
    await assert.rejects(active.insert('projects', usedId, { name: undefined }));
    await assert.rejects(active.insert('boardMembers', usedId, { boardId: 'foreign', userId: higherId }));
    await assert.rejects(active.read('installation', usedId));
    await active.insert('projects', usedId, { name: 'Active', rank: '9007199254740993', createdAt, updatedAt: null });
    await staged.insert('projects', usedId, { name: 'Staged', rank: -9007199254740993n, createdAt, updatedAt: null });
    assert.deepEqual(await active.read('projects', usedId),
      { id: usedId, name: 'Active', rank: 9007199254740993n, createdAt, updatedAt: null, revision: 1 });
    assert.equal((await staged.read('projects', usedId)).name, 'Staged');
    assert.equal((await db.collection('projects').findOne({ generationId: activeGenerationId }, { promoteLongs: false })).rank.toString(),
      '9007199254740993');
    const activeProjectKey = workspaceKey(activeGenerationId, usedId);
    await db.collection('projects').updateOne({ _id: activeProjectKey }, { $set: { rank: new Double(1.5) } });
    await assert.rejects(active.read('projects', usedId), /BSON Long/u);
    await db.collection('projects').updateOne({ _id: activeProjectKey }, { $set: { rank: encodeRank('9007199254740993') } });
    assert.equal(await active.update('projects', usedId, { name: 'Updated' }, 1), true);
    assert.equal(await active.update('projects', usedId, { name: 'Stale' }, 1), false);
    assert.equal((await staged.read('projects', usedId)).revision, 1);
    assert.equal(await active.delete('projects', usedId, 1), false);
    assert.equal(await active.delete('projects', usedId, 2), true);
    assert.equal(await active.read('projects', usedId), null);
    assert.equal((await staged.read('projects', usedId)).name, 'Staged');

    const next = newPublicId;
    const localUser = next();
    await active.insert('users', localUser, { normalizedEmail: 'one@example.test', normalizedUsername: null });
    await assert.rejects(active.update('users', localUser, { normalizedEmail: '' }, 1));
    assert.equal((await active.read('users', localUser)).normalizedEmail, 'one@example.test');
    await assert.rejects(active.insert('users', next(), { normalizedEmail: 'invalid@example.test', normalizedUsername: ['member'] }));
    await active.insert('users', next(), { normalizedEmail: 'two@example.test', normalizedUsername: null });
    await active.insert('users', next(), { normalizedEmail: 'three@example.test', normalizedUsername: 'member' });
    await rejectDuplicate(active.insert('users', next(), { normalizedEmail: 'one@example.test' }));
    await rejectDuplicate(active.insert('users', next(), { normalizedEmail: 'four@example.test', normalizedUsername: 'member' }));
    await staged.insert('users', next(), { normalizedEmail: 'three@example.test', normalizedUsername: 'member' });

    const boardId = next();
    await active.insert('lists', next(), { boardId, kind: 'finite', rank: rankSpacing });
    await active.insert('lists', next(), { boardId, kind: 'finite', rank: 2n * rankSpacing });
    await active.insert('lists', next(), { boardId, kind: 'archive', rank: null });
    await active.insert('lists', next(), { boardId, kind: 'trash', rank: null });
    await rejectDuplicate(active.insert('lists', next(), { boardId, kind: 'archive', rank: null }));
    await staged.insert('lists', next(), { boardId, kind: 'archive', rank: null });

    const listId = next();
    const olderId = next();
    await active.insert('cards', higherId, { boardId, listId, rank: -1n, listChangedAt: createdAt, historySequence: '9007199254740993' });
    await active.insert('cards', usedId, { boardId, listId, rank: -1n, listChangedAt: createdAt, historySequence: '9007199254740993' });
    await active.insert('cards', olderId, { boardId, listId, rank: -2n, listChangedAt: createdAt, historySequence: '9007199254740992' });
    const cards = db.collection('cards');
    const anchor = { generationId: activeGenerationId, listId };
    const placed = await cards.find(anchor).sort({ rank: 1, id: 1 }).hint('list_placement').toArray();
    const historical = await cards.find(anchor).sort({ listChangedAt: -1, historySequence: -1, id: -1 }).hint('list_history').toArray();
    assert.deepEqual(placed.map(({ id }) => id), [olderId, usedId, higherId]);
    assert.deepEqual(historical.map(({ id }) => id), [higherId, usedId, olderId]);

    const links = [
      ['boardMembers', { boardId, userId: next() }],
      ['fieldValues', { cardId: next(), fieldGroupId: next(), fieldDefinitionId: next(), value: null }],
      ['sessions', { tokenDigest: 'c'.repeat(64), userId: next(), expiresAt }],
      ['commands', { actorId: next(), operationId: 'cards.move', idempotencyKey: next() }],
      ['events', { boardId, sequence: '9007199254740993' }],
      ['importIds', { entity: 'card', sourceId: '9007199254740993' }],
    ];
    for (const [collection, fields] of links) {
      await active.insert(collection, next(), fields);
      await rejectDuplicate(active.insert(collection, next(), fields));
      await staged.insert(collection, next(), fields);
    }
    const fileId = '03000000-0000-4000-8000-000000000001';
    const mappingId = next();
    await assert.rejects(active.insert('importIds', next(), { entity: 'card', sourceId: fileId }));
    await assert.rejects(active.insert('importIds', next(), { entity: 'attachment', sourceId: fileId }));
    await active.insert('importIds', mappingId, { entity: 'uploaded_file', sourceId: fileId });
    await active.insert('importIds', next(), { entity: 'uploaded_file', sourceId: '9007199254740993' });
    assert.equal((await active.read('importIds', mappingId)).sourceId, fileId);
    await assert.rejects(active.update('importIds', mappingId, { sourceId: '12' }, 1), /mapping identities/u);

    await db.collection('installation').updateOne({ _id: 'installation' }, { $set: { activeGenerationId: stagedGenerationId } });
    await assert.rejects(active.read('projects', usedId), /bound workspace generation/u);
    await assert.rejects(staged.update('projects', usedId, { name: 'Stale staging handle' }, 1), /bound workspace generation/u);
    assert.equal((await (await openActiveWorkspace(db, installationId)).read('projects', usedId)).name, 'Staged');
  });
});
