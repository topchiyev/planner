import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Long } from 'mongodb';
import { cardMentionToken } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const cardPath = (id) => '/api/v1/cards/' + id;
const boardPath = (id) => '/api/v1/boards/' + id;
const listCards = (id) => '/api/v1/lists/' + id + '/cards';

async function workspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function login(f, actor) {
  const loggedIn = await f.login(actor);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

const mutate = (f, cookie, method, path, revision, body, key = randomUUID()) =>
  f.call(path, cookie, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'If-Match': `"${revision}"`, 'Idempotency-Key': key,
  } });

async function expectResponse(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data).slice(0, 1000));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result.data;
}

test('direct editors create ranked cards under the finite list revision and current board type rules', { timeout: 90_000 }, async () => {
  await workspace(async (f) => {
    const editor = await login(f, ids.firstEditor);
    const viewer = await login(f, ids.viewer);
    const manager = await login(f, ids.projectManager);
    const other = await login(f, ids.admin);
    await f.db.collection('users').updateOne({ ...f.scope, id: ids.firstEditor }, { $set: { 'preferences.followOwnCards': true } });
    await f.insert('boardPreferences', fixtureId(9001), { boardId: ids.privateBoard, defaultCardType: 'story', restrictedCardType: 'project' });
    await expectResponse(mutate(f, viewer, 'POST', listCards(ids.privateActiveList), 1, { name: 'Viewer denied' }), 403);
    await expectResponse(mutate(f, manager, 'POST', listCards(ids.sharedActiveList), 1, { name: 'Manager without direct editor' }), 403);
    await expectResponse(mutate(f, other, 'POST', listCards(ids.privateActiveList), 1, { name: 'Private scope' }), 404);
    await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateArchive), 1, { name: 'Historical placement' }), 403);
    await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateTrash), 1, { name: 'Historical placement' }), 403);
    await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateActiveList), 1, { name: 'Wrong type', type: 'story' }), 422, 'CARD_TYPE_RESTRICTED');
    await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateClosedList), 1,
      { name: 'Foreign anchor', beforeCardId: ids.sharedTarget }), 409, 'CARD_ORDER_CONFLICT');

    const body = { name: '  Track fixture  ', description: 'Unmodified  **Markdown**' };
    const key = randomUUID();
    const closed = (await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateClosedList), 1, body, key), 201)).data;
    assert.deepEqual([closed.card.name, closed.card.type, closed.card.closed, closed.listRevision, closed.listOrderVersion],
      ['Track fixture', 'project', true, 2, 2]);
    assert.deepEqual((await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateClosedList), 1,
      { ...body, name: 'Track fixture', beforeCardId: null }, key), 201)).data, closed);
    await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateClosedList), 1, { name: 'Old list version' }), 409, 'REVISION_CONFLICT');
    const activity = await f.db.collection('activities').findOne({ ...f.scope, cardId: closed.card.id });
    assert.equal(activity.kind, 'createCard');
    assert.equal(activity.actorId, ids.firstEditor);
    const follows = await f.db.collection('cardFollows').find({ ...f.scope, cardId: closed.card.id }).toArray();
    assert.deepEqual(follows.map(({ userId, isPermanent }) => [userId, isPermanent]), [[ids.firstEditor, true]]);
    const emitted = await f.db.collection('events').findOne({ ...f.scope, commandId: activity.commandId });
    assert.deepEqual([emitted.boardId, emitted.kind, emitted.payload], [ids.privateBoard, 'card.changed', { id: closed.card.id, revision: 1 }]);
    assert.equal(await f.db.collection('notifications').countDocuments(f.scope), 0);
    assert.equal((await expectResponse(f.call(cardPath(closed.card.id), viewer), 200)).data.description, body.description);
    assert.equal((await expectResponse(f.call(boardPath(ids.privateBoard) + '/workspace', editor), 200)).data.orderVersion, 1);

    const otherCard = fixtureId(9002);
    await f.db.collection('cards').updateOne({ ...f.scope, id: ids.activeCard }, { $set: { rank: Long.fromBigInt(9223372036854775806n) } });
    await f.insert('cards', otherCard, { boardId: ids.privateBoard, listId: ids.privateActiveList,
      type: 'project', kind: 'board', name: 'Adjacent card', rank: '9223372036854775807' });
    const dense = (await expectResponse(mutate(f, editor, 'POST', listCards(ids.privateActiveList), 1,
      { name: 'Middle', beforeCardId: otherCard }), 201)).data;
    const inOrder = (await expectResponse(f.call(boardPath(ids.privateBoard) + '/cards?listIds=' + ids.privateActiveList, editor), 200)).data;
    assert.deepEqual(inOrder.map(({ id, rank, revision }) => [id, rank, revision]),
      [[ids.activeCard, '1024', 2], [dense.card.id, '2048', 1], [otherCard, '3072', 2]]);
  });
});

test('card updates preserve hidden fields and exact imported text and synchronize linked closure independently of due dates', { timeout: 90_000 }, async () => {
  await workspace(async (f) => {
    const editor = await login(f, ids.firstEditor);
    const privateOwner = await login(f, ids.privateOwner);
    const viewer = await login(f, ids.viewer);
    const id = ids.sharedTarget;
    const importedName = 'Legacy ' + 'x'.repeat(145);
    const importedText = '  <span>retain this</span>\r\n\r\nUnresolved @[Former](99) and Unicode 🌱  ';
    await f.db.collection('cards').updateOne({ ...f.scope, id }, { $set: {
      name: importedName, description: importedText, dueDate: new Date('2026-03-19T13:22:11.333Z'), isDueCompleted: true,
      stopwatch: { startedAt: null, total: 13 }, coverAttachmentId: fixtureId(9500),
    } });
    await expectResponse(mutate(f, editor, 'PATCH', cardPath(ids.archivedStory), 1, { closed: true }), 403);
    await expectResponse(mutate(f, viewer, 'PATCH', cardPath(ids.activeCard), 1, { closed: true }), 403);
    await expectResponse(mutate(f, privateOwner, 'PATCH', cardPath(id), 1, { closed: true }), 404);
    await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 1, { coverAttachmentId: null }), 422, 'INVALID_REQUEST');
    await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 1, { description: 'x'.repeat(8001) }), 422, 'INVALID_REQUEST');
    await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 2, { closed: false }), 409, 'REVISION_CONFLICT');
    const change = (await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 1,
      { type: 'story', dueDate: '2026-04-04T22:33:44.000Z' }), 200)).data;
    assert.equal(Object.hasOwn(change, 'coverAttachmentId'), false);
    assert.deepEqual([change.card.name, change.card.type, change.card.closed, change.card.dueDateCompleted], [importedName, 'story', true, true]);
    assert.deepEqual(change.stopwatch, { startedAt: null, total: 13 });
    const afterType = (await expectResponse(f.call(cardPath(id), editor), 200)).data;
    assert.equal(afterType.description, importedText);
    assert.equal(afterType.coverAttachmentId, null);
    assert.equal((await f.db.collection('cards').findOne({ ...f.scope, id })).coverAttachmentId, fixtureId(9500));

    const second = fixtureId(9100);
    await f.insert('tasks', second, { checklistId: ids.checklist, linkedCardId: id, completed: true });
    assert.equal((await f.db.collection('tasks').findOne({ ...f.scope, id: ids.linkedTask })).completed, false);
    const key = randomUUID();
    const reopen = { type: 'project', closed: false };
    const saved = (await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 2, reopen, key), 200)).data;
    assert.deepEqual((await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 2, reopen, key), 200)).data, saved);
    assert.deepEqual([saved.card.closed, saved.card.dueDateCompleted, saved.card.listId, saved.card.rank], [false, true, ids.sharedActiveList, '1024']);
    for (const taskId of [ids.linkedTask, second]) {
      const row = await f.db.collection('tasks').findOne({ ...f.scope, id: taskId });
      assert.deepEqual([row.completed, row.revision], [false, 2]);
    }
    assert.equal((await f.db.collection('checklists').findOne({ ...f.scope, id: ids.checklist })).revision, 2);
    assert.equal((await f.db.collection('cards').findOne({ ...f.scope, id: ids.activeCard })).revision, 2);
    assert.equal((await f.db.collection('tasks').findOne({ generationId: f.stagedGenerationId, id: ids.linkedTask })).revision, 1);
    const receipt = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    const events = await f.db.collection('events').find({ ...f.scope, commandId: receipt.id }).sort({ ordinal: 1 }).toArray();
    assert.deepEqual(events.map(({ boardId, kind, payload }) => [boardId, kind, payload]), [
      [ids.sharedBoard, 'card.changed', { id, revision: 3 }], [ids.privateBoard, 'board.invalidated', {}],
    ]);
    const visibleLink = (await expectResponse(f.call(cardPath(ids.activeCard) + '/checklists', viewer), 200)).data[0].tasks[0];
    assert.equal(visibleLink.kind, 'unavailable');
    const cleared = (await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 3, { dueDate: null }), 200)).data.card;
    assert.deepEqual([cleared.closed, cleared.dueDate, cleared.dueDateCompleted], [false, null, null]);
    await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 4, { dueDateCompleted: true }), 422, 'CARD_DUE_DATE_REQUIRED');
    const assigned = (await expectResponse(mutate(f, editor, 'PATCH', cardPath(id), 4, { dueDate: '2026-03-19T13:13:59.719Z' }), 200)).data.card;
    assert.equal(assigned.dueDateCompleted, false);
    assert.equal(await f.db.collection('notifications').countDocuments(f.scope), 0);
  });
});

test('stopwatch uses exact journal time and mention lookup returns active direct members with minimal identities', { timeout: 90_000 }, async () => {
  await workspace(async (f) => {
    const editor = await login(f, ids.firstEditor);
    const viewer = await login(f, ids.viewer);
    const id = ids.activeCard;
    const path = cardPath(id);
    const mentions = boardPath(ids.privateBoard) + '/mention-members';
    await expectResponse(f.call(mentions, viewer), 403);
    const eligible = (await expectResponse(f.call(mentions + '?q=second', editor), 200)).data;
    assert.deepEqual(eligible, [{ id: ids.secondEditor, name: 'Fixture second-editor', username: null }]);
    assert.equal(cardMentionToken(eligible[0]), `@[Fixture second-editor](${ids.secondEditor})`);
    for (const q of ['disabled', 'unrelated']) assert.deepEqual((await expectResponse(f.call(mentions + '?q=' + q, editor), 200)).data, []);
    assert.deepEqual((await expectResponse(f.call(boardPath(ids.sharedBoard) + '/mention-members?q=second', editor), 200)).data, []);

    const started = (await expectResponse(mutate(f, editor, 'PATCH', path, 1, { stopwatchAction: 'start' }), 200)).data;
    assert.ok(started.stopwatch.startedAt);
    assert.equal(started.stopwatch.total, 0);
    assert.equal((await expectResponse(f.call(path, editor), 200)).data.revision, 2);
    const oldStart = new Date(Date.now() - 12_500).toISOString();
    await f.db.collection('cards').updateOne({ ...f.scope, id }, { $set: { stopwatch: { startedAt: oldStart, total: 7 } } });
    const stopKey = randomUUID();
    const stopped = (await expectResponse(mutate(f, editor, 'PATCH', path, 2, { stopwatchAction: 'stop' }, stopKey), 200)).data;
    const receipt = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: stopKey });
    assert.deepEqual(stopped.stopwatch, { startedAt: null, total: 7 + Math.floor((receipt.createdAt.valueOf() - Date.parse(oldStart)) / 1000) });
    assert.deepEqual((await expectResponse(mutate(f, editor, 'PATCH', path, 2, { stopwatchAction: 'stop' }, stopKey), 200)).data, stopped);
    await expectResponse(mutate(f, editor, 'PATCH', path, 3, { stopwatchAction: 'stop' }), 422, 'CARD_STOPWATCH_STATE');
    const reset = (await expectResponse(mutate(f, editor, 'PATCH', path, 3, { stopwatchAction: 'reset' }), 200)).data;
    assert.deepEqual(reset.stopwatch, { startedAt: null, total: 0 });
    assert.equal(reset.card.revision, 4);
    assert.equal((await expectResponse(f.call(path, viewer), 200)).data.revision, 4);
  });
});
