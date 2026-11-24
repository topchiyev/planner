import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { labelColorSchema, relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const board = (id = ids.privateBoard) => '/api/v1/boards/' + id;
const card = (id) => '/api/v1/cards/' + id;
const label = (id) => '/api/v1/labels/' + id;

async function workspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, id) {
  const response = await f.login(id);
  assert.equal(response.status, 200);
  return cookieOf(response);
}

function mutate(f, cookie, method, path, revision, body, key = randomUUID()) {
  return f.call(path, cookie, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'Idempotency-Key': key,
    ...(revision !== undefined && { 'If-Match': `"${revision}"` }),
  } });
}

async function expectResponse(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result;
}
const data = async (pending, status = 200) => (await expectResponse(pending, status)).data.data;

test('board palette uses scoped ranked IDs, accepts unnamed and duplicate names, and unlinks active and historical cards', { timeout: 100_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const admin = await signIn(f, ids.admin);
    assert.equal(labelColorSchema.options.length, 42);
    const create = (cookie, revision, body, key) => mutate(f, cookie, 'POST', board() + '/labels', revision, body, key);
    await expectResponse(create(viewer, 1, { color: 'pirate-gold' }), 403);
    await expectResponse(mutate(f, admin, 'POST', board(ids.sharedBoard) + '/labels', 1, { color: 'pirate-gold' }), 403);
    await expectResponse(create(editor, undefined, { color: 'pirate-gold' }), 422, 'INVALID_REQUEST');
    await expectResponse(create(editor, 1, { color: '#fafa00' }), 422, 'INVALID_REQUEST');

    const key = randomUUID();
    const first = await data(create(editor, 1, { color: 'pirate-gold' }, key), 201);
    assert.deepEqual([first.label.name, first.label.color, first.label.rank, first.label.revision, first.boardRevision],
      [null, 'pirate-gold', '1024', 1, 2]);
    assert.deepEqual(await data(create(editor, 1, { name: null, color: 'pirate-gold' }, key), 201), first);
    const second = await data(create(editor, 2, { name: ' Progress ', color: 'berry-red' }), 201);
    const original = first.label.id;
    assert.equal(second.label.rank, '2048');
    assert.notEqual(second.label.id, original);
    await expectResponse(mutate(f, viewer, 'PATCH', label(original), 1, { name: 'Denied' }), 403);
    await expectResponse(mutate(f, editor, 'PATCH', label(original), 2, { name: 'Progress' }), 409, 'REVISION_CONFLICT');
    const changed = await data(mutate(f, editor, 'PATCH', label(original), 1, { name: 'Progress', color: 'lagoon-blue' }));
    assert.deepEqual([changed.label.name, changed.label.revision, changed.boardRevision], ['Progress', 2, 4]);
    assert.equal((await data(f.call(board() + '/labels', viewer))).filter(({ name }) => name === 'Progress').length, 2);

    const otherLabel = fixtureId(5000);
    await f.insert('labels', otherLabel, { boardId: ids.sharedBoard, name: 'Foreign palette', color: 'berry-red', rank: '1' });
    await f.insert('labels', original, { boardId: ids.privateBoard, name: 'Staged copy', color: 'berry-red', rank: '1' }, f.stagedGenerationId);
    const linkPath = card(ids.activeCard) + '/labels/' + original;
    await expectResponse(mutate(f, editor, 'PUT', card(ids.activeCard) + '/labels/' + otherLabel, 1), 404);
    await expectResponse(mutate(f, viewer, 'PUT', linkPath, 1), 403);
    await expectResponse(mutate(f, editor, 'PUT', card(ids.archivedStory) + '/labels/' + original, 1), 403);
    const linked = await data(mutate(f, editor, 'PUT', linkPath, 1));
    assert.deepEqual(linked, { id: ids.activeCard, revision: 2 });
    const edges = f.db.collection('cardLabels');
    const edge = await edges.findOne({ ...f.scope, cardId: ids.activeCard, labelId: original });
    assert.deepEqual(await data(mutate(f, editor, 'PUT', linkPath, 2)), linked);
    assert.deepEqual(await edges.findOne({ ...f.scope, cardId: ids.activeCard, labelId: original }), edge);
    await f.insert('cardLabels', fixtureId(5001), { cardId: ids.archivedStory, labelId: original });
    await f.insert('cardLabels', fixtureId(5002), { cardId: ids.sharedTarget, labelId: original });
    await expectResponse(mutate(f, editor, 'DELETE', card(ids.archivedStory) + '/labels/' + original, 1), 403);
    const missing = await expectResponse(mutate(f, editor, 'DELETE', card(ids.activeCard) + '/labels/' + second.label.id, 2), 204);
    assert.equal(missing.headers[relationshipParentRevisionHeader], '2');

    const deletionKey = randomUUID();
    const remove = (cookie) => mutate(f, cookie, 'DELETE', label(original), 2, undefined, deletionKey);
    const deleted = await expectResponse(remove(editor), 204);
    assert.equal(deleted.headers[relationshipParentRevisionHeader], '5');
    await expectResponse(remove(editor), 204);
    await expectResponse(remove(viewer), 404);
    assert.equal((await data(f.call(card(ids.activeCard), editor))).revision, 3);
    const archived = await data(f.call(card(ids.archivedStory), viewer));
    assert.deepEqual([archived.revision, archived.labels], [2, []]);
    assert.equal((await data(f.call(card(ids.sharedTarget), editor))).revision, 1);
    assert.equal(await edges.countDocuments({ ...f.scope, labelId: original }), 1);
    assert.equal(await f.db.collection('labels').countDocuments({ generationId: f.stagedGenerationId, id: original }), 1);
    assert.equal((await data(f.call(board() + '/workspace', editor))).orderVersion, 1);
  });
});

test('direct assignment distinguishes implicit, explicit and legacy follows and keeps personal state private', { timeout: 120_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const second = await signIn(f, ids.secondEditor);
    const manager = await signIn(f, ids.privateOwner);
    const id = fixtureId(5100);
    await f.insert('cards', id, { boardId: ids.privateBoard, listId: ids.privateActiveList, name: 'Affiliation card',
      rank: '4096', type: 'project', kind: 'board', closed: false });
    const follows = f.db.collection('cardFollows');
    const profile = (who = editor, cardId = id) => data(f.call(card(cardId), who));
    const set = (method, userId, revision, cookie = editor, key) => mutate(f, cookie, method, card(id) + '/assignees/' + userId, revision, undefined, key);
    const follow = (method, cookie, revision, cardId = id) => mutate(f, cookie, method, card(cardId) + '/follow', revision);
    const followFor = (userId) => follows.findOne({ ...f.scope, cardId: id, userId });

    await expectResponse(set('PUT', ids.secondEditor, 1, viewer), 403);
    await expectResponse(set('PUT', ids.disabledMember, 1), 422, 'INELIGIBLE_ACCOUNT');
    await expectResponse(set('PUT', ids.unrelated, 1), 422, 'INELIGIBLE_ACCOUNT');
    assert.deepEqual(await data(set('PUT', ids.secondEditor, 1)), { id, revision: 2 });
    assert.deepEqual((await profile()).assignees, [{ id: ids.secondEditor, name: 'Fixture second-editor', username: null }]);
    const implicit = await followFor(ids.secondEditor);
    assert.equal(implicit.isPermanent, false);
    assert.equal((await profile(second)).following, true);
    assert.equal((await profile(viewer)).following, false);
    assert.equal((await profile()).following, false);
    await expectResponse(follow('PUT', second, 1), 409, 'REVISION_CONFLICT');
    await expectResponse(follow('PUT', second, undefined), 422, 'INVALID_REQUEST');
    const personal = await data(follow('PUT', second, 2));
    assert.deepEqual(personal, { following: true, revision: 2 });
    const explicit = await followFor(ids.secondEditor);
    assert.deepEqual([explicit.id, explicit.createdAt, explicit.isPermanent], [implicit.id, implicit.createdAt, true]);
    assert.equal((await profile()).revision, 2);

    const removed = await expectResponse(set('DELETE', ids.secondEditor, 2), 204);
    assert.equal(removed.headers[relationshipParentRevisionHeader], '3');
    assert.deepEqual(await followFor(ids.secondEditor), explicit);
    await expectResponse(follow('DELETE', second, 3), 204);
    assert.equal(await followFor(ids.secondEditor), null);

    assert.equal((await data(set('PUT', ids.secondEditor, 3))).revision, 4);
    assert.equal((await followFor(ids.secondEditor)).isPermanent, false);
    await expectResponse(follow('DELETE', second, 4), 204);
    const stableAssignment = await f.db.collection('cardAssignees').findOne({ ...f.scope, cardId: id, userId: ids.secondEditor });
    assert.equal((await data(set('PUT', ids.secondEditor, 4))).revision, 4);
    assert.equal(await followFor(ids.secondEditor), null);
    assert.deepEqual(await f.db.collection('cardAssignees').findOne({ ...f.scope, cardId: id, userId: ids.secondEditor }), stableAssignment);
    await expectResponse(set('DELETE', ids.secondEditor, 4), 204);

    let revision = 5;
    for (const [index, [userId, marker]] of [[ids.viewer, true], [ids.commentingViewer, null], [ids.firstEditor, undefined]].entries()) {
      await f.insert('cardFollows', fixtureId(5110 + index), { cardId: id, userId, ...(marker === undefined ? {} : { isPermanent: marker }) });
      const legacy = await followFor(userId);
      await data(set('PUT', userId, revision++));
      await expectResponse(set('DELETE', userId, revision++), 204);
      assert.deepEqual(await followFor(userId), legacy);
    }
    await f.insert('cardAssignees', fixtureId(5114), { cardId: id, userId: ids.disabledMember });
    await f.insert('cardFollows', fixtureId(5115), { cardId: id, userId: ids.disabledMember, isPermanent: false });
    const workspacePath = board() + '/cards';
    const unassigned = await data(f.call(workspacePath + '?unassigned=true', editor));
    assert.ok(unassigned.some((row) => row.id === id));
    const disabled = await data(f.call(workspacePath + '?members=' + ids.disabledMember, editor));
    assert.ok(disabled.every((row) => row.id !== id));
    assert.deepEqual((await profile()).assignees, []);
    const purgeStale = await expectResponse(set('DELETE', ids.disabledMember, revision), 204);
    assert.equal(purgeStale.data, '');
    revision++;
    assert.equal(await followFor(ids.disabledMember), null);

    await data(mutate(f, viewer, 'PUT', board() + '/follow', 1));
    assert.deepEqual([(await data(f.call(board() + '/workspace', viewer))).following, (await data(f.call(board() + '/workspace', editor))).following],
      [true, false]);
    assert.equal((await data(f.call(board() + '/workspace', viewer))).board.revision, 1);
    await data(follow('PUT', viewer, 1, ids.archivedStory));
    assert.equal((await profile(viewer, ids.archivedStory)).following, true);
    await expectResponse(set('PUT', ids.viewer, revision, manager), 200);
    await expectResponse(mutate(f, manager, 'DELETE', board() + '/members/' + ids.privateOwner, 1), 204);
    assert.equal((await data(f.call(board() + '/workspace', manager))).board.permissions.canFollow, false);
    await expectResponse(follow('PUT', manager, 1, ids.archivedStory), 403);
    assert.equal((await profile(manager, ids.archivedStory)).following, false);

    const list = await f.db.collection('notifications').find({ ...f.scope, cardId: id }).toArray();
    assert.equal(list.filter(({ recipientId }) => recipientId === ids.firstEditor).length, 0);
    assert.equal(list.filter(({ recipientId }) => recipientId === ids.secondEditor).length, 2);
    const personalAudits = await f.db.collection('auditEntries').find({ ...f.scope,
      action: { $in: ['cards.follow', 'cards.unfollow', 'boards.follow', 'boards.unfollow'] } }).toArray();
    assert.equal(await f.db.collection('events').countDocuments({ ...f.scope, commandId: { $in: personalAudits.map(({ commandId }) => commandId) } }), 0);
  });
});

test('interrupted assignment resumes the same follow, activity, notice and receipt after an acknowledged effect', { timeout: 100_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const recipient = await signIn(f, ids.viewer);
    const token = readSessionCookie(editor);
    const target = fixtureId(5200);
    await f.insert('cards', target, { boardId: ids.privateBoard, listId: ids.privateActiveList, name: 'Recovery card',
      rank: '4096', type: 'project', kind: 'board', closed: false });
    const key = randomUUID();
    const journal = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), 'web', key),
      checkpoint(checkpoint, progress) {
        if (checkpoint === 'effectApplied' && progress === 0) throw new Error('interrupted card assignment');
      },
    });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId: 'cards.assign', idempotencyKey: key,
      input: { id: target, relatedId: ids.viewer, expectedRevision: 1 } }), /interrupted card assignment/u);
    assert.equal(f.gate.ready, false);
    await expectResponse(f.call(card(target), recipient), 503);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const command = () => mutate(f, editor, 'PUT', card(target) + '/assignees/' + ids.viewer, 1, undefined, key);
    assert.deepEqual(await data(command()), { id: target, revision: 2 });
    assert.deepEqual(await data(command()), { id: target, revision: 2 });
    assert.equal((await data(f.call(card(target), recipient))).following, true);
    for (const collection of ['cardAssignees', 'cardFollows', 'activities', 'notifications']) {
      assert.equal(await f.db.collection(collection).countDocuments({ ...f.scope, cardId: target }), 1, collection);
    }
    const owner = await signIn(f, ids.privateOwner);
    await expectResponse(mutate(f, owner, 'DELETE', board() + '/members/' + ids.viewer, 1), 204);
    await expectResponse(f.call(card(target), recipient), 404);
    await expectResponse(command(), 422, 'INELIGIBLE_ACCOUNT');
    assert.deepEqual((await data(f.call(card(target), editor))).assignees, []);
    assert.equal(await f.db.collection('cardFollows').countDocuments({ ...f.scope, cardId: target, userId: ids.viewer }), 0);
  });
});
