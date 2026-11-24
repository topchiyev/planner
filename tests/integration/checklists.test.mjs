import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const card = (id) => '/api/v1/cards/' + id;
const group = (id) => '/api/v1/checklists/' + id;
const task = (id) => '/api/v1/tasks/' + id;
const board = (id) => '/api/v1/boards/' + id;

async function workspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, actor) {
  const loggedIn = await f.login(actor);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

function change(f, actor, method, path, revision, body, key = randomUUID()) {
  return f.call(path, actor, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(actor)), 'If-Match': `"${revision}"`, 'Idempotency-Key': key,
  } });
}

async function expectResponse(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data).slice(0, 1000));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result;
}

const data = async (pending, status = 200) => (await expectResponse(pending, status)).data.data;
const row = (f, name, id) => f.db.collection(name).findOne({ ...f.scope, id });

test('checklists and ordinary tasks keep independent order versions, eligible assignment and atomic local placement', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const admin = await signIn(f, ids.admin);
    const path = card(ids.activeCard) + '/checklists';
    const list = () => data(f.call(path, editor));
    assert.deepEqual((await list()).map(({ orderVersion, showOnFront, hideCompleted }) => [orderVersion, showOnFront, hideCompleted]), [[1, false, false]]);
    assert.equal((await data(f.call(card(ids.activeCard), editor))).checklistOrderVersion, 1);
    await expectResponse(f.call(path + '?boardId=' + ids.sharedBoard, editor), 404);
    await expectResponse(change(f, viewer, 'POST', path, 1, { name: 'Viewer denied' }), 403);
    await expectResponse(change(f, admin, 'POST', path, 1, { name: 'Private scope' }), 404);
    await expectResponse(change(f, editor, 'POST', card(ids.archivedStory) + '/checklists', 1, { name: 'Historical scope' }), 403);
    await expectResponse(change(f, editor, 'POST', path, 1, { name: 'Missing anchor', beforeChecklistId: fixtureId(19000) }), 409, 'CHECKLIST_ORDER_CONFLICT');
    const key = randomUUID();
    const create = { name: '  Dispatch work  ', beforeChecklistId: ids.checklist };
    const made = await data(change(f, editor, 'POST', path, 1, create, key), 201);
    const id = made.checklist.id;
    assert.deepEqual(made, { checklist: { id, revision: 1 }, cardRevision: 2, checklistOrderVersion: 2 });
    assert.deepEqual(await data(change(f, editor, 'POST', path, 1, { ...create, name: 'Dispatch work', showOnFront: true, hideCompleted: false }, key), 201), made);
    assert.deepEqual((await list()).map(({ id, showOnFront }) => [id, showOnFront]), [[id, true], [ids.checklist, false]]);
    const renamed = await data(change(f, editor, 'PATCH', group(id), 1, { name: 'Revised work', hideCompleted: true }));
    assert.deepEqual([renamed.checklist.revision, renamed.cardRevision, renamed.checklistOrderVersion], [2, 3, 2]);
    assert.equal((await row(f, 'checklists', id)).orderVersion, 1);
    await expectResponse(change(f, editor, 'PATCH', group(id), 2, { beforeChecklistId: null, checklistOrderVersion: 1 }), 409, 'CHECKLIST_ORDER_CONFLICT');
    const reordered = await data(change(f, editor, 'PATCH', group(id), 2, { beforeChecklistId: null, checklistOrderVersion: 2 }));
    assert.deepEqual([reordered.checklist.revision, reordered.cardRevision, reordered.checklistOrderVersion], [3, 4, 3]);
    assert.deepEqual((await list()).map(({ id }) => id), [ids.checklist, id]);

    await expectResponse(change(f, editor, 'POST', group(id) + '/tasks', 3, { name: 'Wrong account', assigneeId: ids.disabledMember }), 422, 'INELIGIBLE_ACCOUNT');
    await expectResponse(change(f, editor, 'POST', group(id) + '/tasks', 3, { name: 'Nonmember', assigneeId: ids.admin }), 422, 'INELIGIBLE_ACCOUNT');
    await expectResponse(change(f, editor, 'POST', group(id) + '/tasks', 3, { name: 'Already complete', completed: true }), 422, 'INVALID_REQUEST');
    const assignment = await data(change(f, editor, 'POST', group(id) + '/tasks', 3, { name: 'Measure prism', assigneeId: ids.secondEditor }), 201);
    const taskId = assignment.task.id;
    assert.deepEqual(assignment, { task: { id: taskId, revision: 1 }, checklist: { checklistId: id, revision: 4, orderVersion: 2 }, cardRevision: 5 });
    const first = (await list()).find((item) => item.id === id).tasks[0];
    assert.deepEqual([first.name, first.completed, first.assignee], ['Measure prism', false,
      { id: ids.secondEditor, name: 'Fixture second-editor', username: null }]);
    await expectResponse(change(f, viewer, 'PATCH', task(taskId), 1, { completed: true }), 403);
    const completeKey = randomUUID();
    const complete = await data(change(f, editor, 'PATCH', task(taskId), 1, { completed: true }, completeKey));
    assert.deepEqual([complete.task.revision, complete.checklist.revision, complete.checklist.orderVersion, complete.cardRevision], [2, 5, 2, 6]);
    assert.deepEqual(await data(change(f, editor, 'PATCH', task(taskId), 1, { completed: true }, completeKey)), complete);
    assert.equal((await row(f, 'cards', ids.activeCard)).closed, false);
    assert.equal(await f.db.collection('activities').countDocuments({ ...f.scope, taskId, kind: 'completeTask' }), 1);
    assert.equal(await f.db.collection('notifications').countDocuments(f.scope), 0);
    const unassign = await data(change(f, editor, 'PATCH', task(taskId), 2, { assigneeId: null }));
    assert.deepEqual([unassign.task.revision, unassign.checklist.revision, unassign.checklist.orderVersion, unassign.cardRevision], [3, 6, 2, 7]);
    assert.equal((await list()).find((item) => item.id === id).tasks[0].assignee, null);

    const other = await f.insert('checklists', fixtureId(19001), { cardId: ids.sharedTarget, name: 'Different card', rank: '1' });
    const moving = { toChecklistId: ids.checklist, beforeTaskId: ids.linkedTask, sourceOrderVersion: 2, destinationOrderVersion: 1 };
    await expectResponse(change(f, editor, 'POST', task(taskId) + '/move', 3, { ...moving, toChecklistId: other }), 404);
    await expectResponse(change(f, editor, 'POST', task(taskId) + '/move', 3, { ...moving, beforeTaskId: taskId }), 409, 'CHECKLIST_ORDER_CONFLICT');
    await expectResponse(change(f, editor, 'POST', task(taskId) + '/move', 3, { ...moving, sourceOrderVersion: 1 }), 409, 'CHECKLIST_ORDER_CONFLICT');
    const moveKey = randomUUID();
    const moved = await data(change(f, editor, 'POST', task(taskId) + '/move', 3, moving, moveKey));
    assert.deepEqual(moved, { task: { id: taskId, revision: 4 }, source: { checklistId: id, revision: 7, orderVersion: 3 },
      destination: { checklistId: ids.checklist, revision: 2, orderVersion: 2 }, cardRevision: 8 });
    assert.deepEqual(await data(change(f, editor, 'POST', task(taskId) + '/move', 3, moving, moveKey)), moved);
    assert.deepEqual((await list())[0].tasks.map(({ id }) => id), [taskId, ids.linkedTask]);
    assert.equal((await row(f, 'tasks', taskId)).completed, true);
    assert.equal((await row(f, 'cards', ids.activeCard)).checklistOrderVersion, 3);

    const removeKey = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const removed = await expectResponse(change(f, editor, 'DELETE', task(taskId), 4, undefined, removeKey), 204);
      assert.equal(removed.headers[relationshipParentRevisionHeader], '3');
      assert.equal(removed.data, '');
    }
    await expectResponse(change(f, viewer, 'DELETE', task(taskId), 4, undefined, removeKey), 404);
    const removed = await expectResponse(change(f, editor, 'DELETE', group(id), 7), 204);
    assert.equal(removed.headers[relationshipParentRevisionHeader], '10');
    assert.equal((await row(f, 'cards', ids.activeCard)).checklistOrderVersion, 4);
    assert.equal((await f.db.collection('checklists').findOne({ generationId: f.stagedGenerationId, id: ids.checklist })).revision, 1);
  });
});

test('linked tasks keep live ACL state, track historical target completion and redact every ordinary projection after purge', { timeout: 140_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const owner = await signIn(f, ids.privateOwner);
    const viewer = await signIn(f, ids.viewer);
    const ownerCard = ids.activeCard;
    const target = ids.sharedTarget;
    const path = card(ownerCard) + '/checklists';
    const groups = (cookie) => data(f.call(path, cookie));
    const findTask = async (cookie, id) => (await groups(cookie)).flatMap(({ tasks }) => tasks).find((row) => row.id === id);
    const unavailable = (row) => {
      assert.equal(row.kind, 'unavailable');
      assert.deepEqual(Object.keys(row).sort(), ['checklistId', 'createdAt', 'id', 'kind', 'rank', 'revision', 'updatedAt']);
    };

    await f.db.collection('checklists').updateOne({ ...f.scope, id: ids.checklist }, { $set: { showOnFront: true, hideCompleted: true } });
    await f.db.collection('tasks').updateOne({ ...f.scope, id: ids.linkedTask }, { $set: { assigneeId: ids.viewer } });
    const byAssignee = board(ids.privateBoard) + '/cards?members=' + ids.viewer;
    assert.deepEqual(await data(f.call(byAssignee, viewer)), []);
    assert.deepEqual((await data(f.call(byAssignee, editor))).map(({ id }) => id), [ownerCard]);
    const malformed = fixtureId(19003);
    await f.insert('tasks', malformed, {
      checklistId: ids.checklist, linkedCardId: null, linkedUnavailable: 'legacy', completed: true,
      name: 'Restricted legacy row', assigneeId: ids.commentingViewer, rank: '1',
    });
    unavailable(await findTask(editor, malformed));
    const malformedAssignee = board(ids.privateBoard) + '/cards?members=' + ids.commentingViewer;
    assert.deepEqual(await data(f.call(malformedAssignee, editor)), []);
    const malformedFront = (await data(f.call(board(ids.privateBoard) + '/cards', editor))).find(({ id }) => id === ownerCard).frontChecklists;
    unavailable(malformedFront[0].tasks.find((task) => task.id === malformed));
    const linked = { linkedCardId: target };
    await expectResponse(change(f, owner, 'POST', group(ids.checklist) + '/tasks', 1, linked), 404);
    await expectResponse(change(f, editor, 'POST', group(ids.checklist) + '/tasks', 1, { ...linked, assigneeId: null }), 422, 'INVALID_REQUEST');
    const creationKey = randomUUID();
    const receipt = await data(change(f, editor, 'POST', group(ids.checklist) + '/tasks', 1, linked, creationKey), 201);
    const id = receipt.task.id;
    assert.equal(JSON.stringify(receipt).includes(target), false);
    assert.equal((await findTask(editor, id)).linkedCard.completed, true);
    unavailable(await findTask(viewer, id));
    const front = (await data(f.call(board(ids.privateBoard) + '/cards', viewer))).find(({ id }) => id === ownerCard).frontChecklists;
    assert.equal(front.length, 1);
    unavailable(front[0].tasks.find((task) => task.id === id));
    await expectResponse(change(f, editor, 'PATCH', task(id), 1, { completed: false }), 422, 'TASK_FIELDS_UNAVAILABLE');

    const newGroup = (await data(change(f, editor, 'POST', path, 2, { name: 'Move links here' }), 201)).checklist.id;
    const handoff = { toChecklistId: newGroup, beforeTaskId: null, sourceOrderVersion: 2, destinationOrderVersion: 1 };
    const handoffKey = randomUUID();
    const moved = await data(change(f, editor, 'POST', task(id) + '/move', 1, handoff, handoffKey));
    assert.equal(moved.destination.checklistId, newGroup);
    assert.equal(JSON.stringify(moved).includes(target), false);

    const edge = await f.db.collection('boardMembers').findOne({ ...f.scope, boardId: ids.sharedBoard, userId: ids.firstEditor });
    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({ _id: edge._id }));
    unavailable(await findTask(editor, id));
    assert.deepEqual(await data(f.call(byAssignee, editor)), []);
    assert.equal((await row(f, 'tasks', id)).linkedCardId, target);
    await expectResponse(change(f, editor, 'POST', task(id) + '/move', 1, handoff, handoffKey), 404);
    await expectResponse(change(f, editor, 'POST', group(ids.checklist) + '/tasks', 1, linked, creationKey), 404);

    const discard = (await data(change(f, editor, 'POST', path, 4, { name: 'Discard hidden links' }), 201)).checklist.id;
    await f.insert('tasks', fixtureId(19002), { checklistId: discard, linkedCardId: target, completed: true, rank: '1' });
    const removeKey = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectResponse(change(f, editor, 'DELETE', group(discard), 1, undefined, removeKey), 204);
    }
    assert.equal(await row(f, 'tasks', fixtureId(19002)), null);
    assert.equal((await row(f, 'cards', target)).revision, 1);

    await f.gate.runCommand(() => f.db.collection('boardMembers').insertOne(edge));
    assert.equal((await findTask(editor, id)).linkedCard.id, target);
    await data(change(f, editor, 'PATCH', card(target), 1, { closed: false }));
    assert.equal((await findTask(editor, id)).linkedCard.completed, false);
    await data(change(f, editor, 'PATCH', card(target), 2, { closed: true }));
    assert.equal((await findTask(editor, id)).linkedCard.completed, true);
    await data(change(f, editor, 'POST', card(target) + '/archive', 3, { sourceOrderVersion: 1, destinationOrderVersion: 1 }));
    assert.equal((await findTask(editor, id)).linkedCard.completed, true);
    await expectResponse(change(f, editor, 'POST', card(target) + '/checklists', 4, { name: 'Read-only in archive' }), 403);
    await data(change(f, editor, 'POST', card(target) + '/restore', 4, {
      sourceOrderVersion: 2, destinationOrderVersion: 2, toListId: ids.sharedActiveList, beforeCardId: null,
    }));
    assert.equal((await findTask(editor, id)).linkedCard.completed, false);

    const owningRevision = (await row(f, 'cards', ownerCard)).revision;
    const beforeType = await findTask(editor, id);
    await data(change(f, editor, 'PATCH', card(ownerCard), owningRevision, { type: 'story' }));
    assert.deepEqual(await findTask(editor, id), beforeType);
    await data(change(f, editor, 'PATCH', card(ownerCard), owningRevision + 1, { type: 'project' }));
    assert.deepEqual(await findTask(editor, id), beforeType);
    const trashed = await data(change(f, editor, 'POST', card(target) + '/trash', 5,
      { sourceOrderVersion: 3, destinationOrderVersion: 1 }));
    assert.equal((await findTask(editor, id)).linkedCard.id, target);
    const purgeKey = randomUUID();
    await data(change(f, editor, 'POST', board(ids.sharedBoard) + '/trash/clear', trashed.destination.revision,
      { trashListId: ids.sharedTrash, trashOrderVersion: trashed.destination.orderVersion, confirmed: true }, purgeKey));
    unavailable(await findTask(editor, id));
    unavailable(await findTask(viewer, id));
    const stored = await row(f, 'tasks', id);
    assert.equal(stored.linkedCardId, null);
    assert.deepEqual(stored.linkedUnavailableProvenance, { id: target, name: 'Cross-board linked target', completed: false });
    const ordinary = await openActiveWorkspace(f.db, f.installationId);
    assert.equal(Object.hasOwn(await ordinary.read('tasks', id), 'linkedUnavailableProvenance'), false);
    const staged = await f.db.collection('tasks').findOne({ generationId: f.stagedGenerationId, id: ids.linkedTask });
    assert.equal(staged.linkedCardId, target);
    const prepared = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: purgeKey });
    const events = await f.db.collection('events').find({ ...f.scope, commandId: prepared.id }).toArray();
    assert.equal(events.length, 2);
    assert.ok(events.every(({ kind, payload }) => kind === 'board.invalidated' && Object.keys(payload).length === 0));
    const after = await findTask(editor, id);
    await expectResponse(change(f, editor, 'POST', task(id) + '/move', after.revision,
      { toChecklistId: ids.checklist, sourceOrderVersion: 2, destinationOrderVersion: 3, beforeTaskId: null }), 404);
  });
});
