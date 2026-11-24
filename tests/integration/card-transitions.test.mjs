import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { workspaceFixtureInstant } from '../fixtures/planner-workspace.ts';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const cardPath = (id) => '/api/v1/cards/' + id;
const listPath = (id) => '/api/v1/lists/' + id;
const boardPath = (id) => '/api/v1/boards/' + id;
const versions = (sourceOrderVersion, destinationOrderVersion) => ({ sourceOrderVersion, destinationOrderVersion });
const safeSequence = 9007199254740993n;

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
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'Idempotency-Key': key, 'If-Match': `"${revision}"`,
  } });
}

async function expected(pending, status, code) {
  const response = await pending;
  assert.equal(response.status, status, JSON.stringify(response.data));
  if (code) assert.equal(response.data.error.code, code);
  return response;
}
const data = async (pending, status = 200) => (await expected(pending, status)).data.data;

test('a same-board move updates closure, scoped linked completion and eligible deduplicated followers', { timeout: 100_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const manager = await signIn(f, ids.privateOwner);
    const card = ids.activeCard;
    const source = ids.privateClosedList;
    const destination = ids.privateActiveList;
    const anchor = fixtureId(5000);
    const hiddenOwner = fixtureId(5001);
    const hiddenChecklist = fixtureId(5002);
    const hiddenTask = fixtureId(5003);
    const left = fixtureId(5005);
    const localChecklist = fixtureId(5006);
    const localTask = fixtureId(5007);
    await f.db.collection('cards').updateOne({ ...f.scope, id: card }, { $set: { listId: source, closed: true } });
    await f.insert('cards', anchor, { boardId: ids.privateBoard, listId: destination, name: 'Anchor',
      kind: 'board', type: 'story', closed: false, rank: '9007199254740996' });
    await f.insert('cards', left, { boardId: ids.privateBoard, listId: destination, name: 'Dense left',
      kind: 'board', type: 'story', closed: false, rank: '9007199254740995' });
    await f.insert('checklists', localChecklist, { cardId: anchor, name: 'Local checklist', rank: '1024' });
    await f.insert('tasks', localTask, { checklistId: localChecklist, linkedCardId: card, completed: false, rank: '1024' });
    await f.insert('cards', hiddenOwner, { boardId: ids.hiddenBoard, listId: ids.hiddenActiveList, name: 'Hidden owner card',
      kind: 'board', type: 'story', closed: false, rank: '2048' });
    await f.insert('checklists', hiddenChecklist, { cardId: hiddenOwner, name: 'Hidden checklist', rank: '1024' });
    await f.insert('tasks', hiddenTask, { checklistId: hiddenChecklist, linkedCardId: card, completed: true, rank: '1024' });
    await f.insert('boardPreferences', fixtureId(5004), { boardId: ids.privateBoard, restrictedCardType: 'story' });
    for (const [i, userId] of [ids.viewer, ids.secondEditor, ids.firstEditor].entries()) {
      await f.insert('boardFollows', fixtureId(5010 + i), { boardId: ids.privateBoard, userId });
    }
    for (const [i, userId] of [ids.viewer, ids.unrelated, ids.disabledMember, ids.firstEditor].entries()) {
      await f.insert('cardFollows', fixtureId(5020 + i), { cardId: card, userId });
    }
    const route = cardPath(card) + '/move';
    const body = { toListId: destination, beforeCardId: anchor, ...versions(1, 1) };
    const move = (revision, changes = {}, key, cookie = editor) => mutate(f, cookie, 'POST', route, revision, { ...body, ...changes }, key);
    await expected(move(1, {}, undefined, viewer), 403);
    await expected(move(1, { beforeCardId: ids.sharedTarget }), 409, 'CARD_ORDER_CONFLICT');
    await expected(move(1, { beforeCardId: fixtureId(5500) }), 409, 'CARD_ORDER_CONFLICT');
    await expected(move(1, { ...versions(2, 1) }), 409, 'CARD_ORDER_CONFLICT');
    await expected(move(1, { toListId: ids.sharedActiveList }), 409, 'CARD_ORDER_CONFLICT');
    const key = randomUUID();
    const moved = await data(move(1, {}, key));
    assert.deepEqual(moved.card, { id: card, boardId: ids.privateBoard, listId: destination, kind: 'board', closed: false, revision: 2 });
    assert.deepEqual([moved.source.orderVersion, moved.destination.orderVersion], [2, 2]);
    assert.deepEqual(await data(move(1, {}, key)), moved);
    await expected(move(1), 409, 'REVISION_CONFLICT');
    const saved = await data(f.call(cardPath(card), editor));
    assert.equal(saved.type, 'project');
    assert.equal(saved.closed, false);
    await expected(f.call(cardPath(hiddenOwner), editor), 404);
    assert.deepEqual(await f.db.collection('tasks').findOne({ ...f.scope, id: hiddenTask }, { projection: { _id: 0, completed: 1, revision: 1 } }),
      { completed: false, revision: 2 });
    assert.equal((await f.db.collection('cards').findOne({ ...f.scope, id: hiddenOwner })).revision, 2);
    const rankedOwner = await f.db.collection('cards').findOne({ ...f.scope, id: anchor }, { promoteLongs: false });
    assert.deepEqual([rankedOwner.rank.toBigInt(), rankedOwner.revision], [3072n, 2]);
    assert.equal((await f.db.collection('checklists').findOne({ ...f.scope, id: localChecklist })).revision, 2);
    assert.equal((await f.db.collection('tasks').findOne({ ...f.scope, id: localTask })).revision, 2);
    const [activity] = await f.db.collection('activities').find({ ...f.scope, cardId: card, kind: 'moveCard' }).toArray();
    assert.deepEqual([activity.fromListId, activity.toListId], [source, destination]);
    const notices = await f.db.collection('notifications').find({ ...f.scope, cardId: card }).sort({ recipientId: 1 }).toArray();
    assert.deepEqual(notices.map(({ recipientId, activityId }) => [recipientId, activityId]), [[ids.secondEditor, activity.id], [ids.viewer, activity.id]]);
    const hiddenEvents = await f.db.collection('events').find({ ...f.scope, boardId: ids.hiddenBoard, commandId: activity.commandId }).toArray();
    assert.deepEqual(hiddenEvents.map(({ kind, payload }) => [kind, payload]), [['board.invalidated', {}]]);
    const localEvents = await f.db.collection('events').find({ ...f.scope, boardId: ids.privateBoard, commandId: activity.commandId })
      .sort({ sequence: 1 }).toArray();
    assert.deepEqual(localEvents.map(({ kind, payload }) => [kind, payload]), [['card.changed', { id: card, revision: 2 }], ['board.invalidated', {}]]);
    assert.equal(await f.db.collection('activities').countDocuments({ ...f.scope, cardId: card }), 1);

    await data(mutate(f, editor, 'PATCH', cardPath(card), 2, { closed: true }));
    const priorReorder = await f.db.collection('cards').findOne({ ...f.scope, id: card });
    const reordered = await data(move(3, { beforeCardId: null, ...versions(2, 2) }));
    assert.equal(reordered.card.closed, true);
    assert.deepEqual(reordered.source, reordered.destination);
    assert.equal(reordered.destination.orderVersion, 3);
    const afterReorder = await f.db.collection('cards').findOne({ ...f.scope, id: card });
    assert.deepEqual(afterReorder.listChangedAt, priorReorder.listChangedAt);

    await expected(mutate(f, manager, 'PATCH', boardPath(ids.privateBoard) + '/members/' + ids.firstEditor, 1,
      { role: 'viewer', canComment: false }), 200);
    await expected(move(1, {}, key), 403);
  });
});

test('archive, trash and restore preserve graph and due state with exact signed history sequence', { timeout: 100_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const card = ids.activeCard;
    const id = { ...f.scope, id: card };
    const cards = f.db.collection('cards');
    const stopwatch = { startedAt: workspaceFixtureInstant, total: 32 };
    await cards.updateOne(id, { $set: { closed: true, dueDate: new Date(workspaceFixtureInstant), dueDateCompleted: true, stopwatch } });
    const transition = (action, revision, body, key) => mutate(f, editor, 'POST', cardPath(card) + '/' + action, revision, body, key);
    const archiveKey = randomUUID();
    const archived = await data(transition('archive', 1, versions(1, 1), archiveKey));
    assert.deepEqual([archived.card.kind, archived.card.closed, archived.card.revision, archived.source.orderVersion, archived.destination.orderVersion],
      ['archive', true, 2, 2, 2]);
    assert.deepEqual(await data(transition('archive', 1, versions(1, 1), archiveKey)), archived);
    const historical = await data(f.call(cardPath(card), viewer));
    assert.deepEqual([historical.previousListId, historical.closed, historical.dueDateCompleted, historical.permissions.canEdit,
      historical.permissions.canComment, historical.stopwatch], [ids.privateActiveList, true, true, false, false, stopwatch]);
    await expected(mutate(f, editor, 'PATCH', cardPath(card), 2, { name: 'Historical edit' }), 403);

    const trashed = await data(transition('trash', 2, versions(2, 1)));
    assert.deepEqual([trashed.card.kind, trashed.card.closed, trashed.source.orderVersion, trashed.destination.orderVersion], ['trash', true, 3, 2]);
    const before = await cards.findOne(id, { promoteLongs: false });
    assert.deepEqual([before.rank, before.previousListId, before.historySequence.toBigInt()], [null, ids.privateActiveList, safeSequence + 2n]);
    const restored = await data(transition('restore', 3, versions(2, 2)));
    assert.deepEqual([restored.card.kind, restored.card.listId, restored.card.closed], ['board', ids.privateActiveList, false]);
    const after = await cards.findOne(id, { promoteLongs: false });
    assert.equal(after.previousListId, null);
    assert.deepEqual(after.previousListProvenance, { listId: ids.privateActiveList, at: after.listChangedAt.toISOString(), reason: 'restored' });
    assert.equal(after.historySequence.toBigInt(), safeSequence + 2n);
    assert.deepEqual(after.stopwatch, stopwatch);
    assert.equal(after.dueDateCompleted, true);
    assert.equal(await f.db.collection('checklists').countDocuments({ ...f.scope, cardId: card }), 1);
    const board = await f.db.collection('boards').findOne({ ...f.scope, id: ids.privateBoard }, { promoteLongs: false });
    assert.deepEqual([board.historySequence.toBigInt(), board.orderVersion], [safeSequence + 2n, 1]);

    const restoreMissing = cardPath(ids.archivedStory) + '/restore';
    const original = await cards.findOne({ ...f.scope, id: ids.archivedStory });
    await expected(mutate(f, editor, 'POST', restoreMissing, 1, versions(3, null)), 422, 'RESTORE_TARGET_REQUIRED');
    assert.deepEqual(await cards.findOne({ ...f.scope, id: ids.archivedStory }), original);
    const resolved = await data(mutate(f, editor, 'POST', restoreMissing, 1,
      { toListId: ids.privateClosedList, beforeCardId: null, ...versions(3, 1) }));
    assert.deepEqual([resolved.card.kind, resolved.card.listId, resolved.card.closed], ['board', ids.privateClosedList, true]);
    const read = await openActiveWorkspace(f.db, f.installationId);
    assert.equal(Object.hasOwn(await read.read('cards', card), 'previousListProvenance'), false);
  });
});

test('multi-batch list deletion resumes trash transitions and exact editor receipt without duplicate activity', { timeout: 120_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const other = await signIn(f, ids.secondEditor);
    const owner = await signIn(f, ids.privateOwner);
    const token = readSessionCookie(editor);
    const list = ids.privateClosedList;
    const body = { sourceOrderVersion: 1, trashOrderVersion: 1, boardOrderVersion: 1 };
    const cardCount = 130;
    const idsToMove = Array.from({ length: cardCount }, (_, index) => fixtureId(6000 + index));
    for (const [index, id] of idsToMove.entries()) {
      await f.insert('cards', id, { boardId: ids.privateBoard, listId: list, name: 'Bulk card ' + index,
        kind: 'board', type: 'project', rank: String((index + 1) * 1024), closed: index !== 0 });
    }
    await f.insert('attachments', fixtureId(6500), { cardId: idsToMove[0], kind: 'link', url: 'https://example.invalid/', name: 'Stored link' });
    await f.insert('boardFollows', fixtureId(6501), { boardId: ids.privateBoard, userId: ids.secondEditor });
    await expected(mutate(f, editor, 'DELETE', listPath(ids.privateArchive), 1, body), 403);
    await expected(mutate(f, editor, 'DELETE', listPath(list), 1, { ...body, trashOrderVersion: 2 }), 409, 'LIST_ORDER_CONFLICT');
    const key = randomUUID();
    const journal = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), 'web', key),
      checkpoint(checkpoint, progress) {
        if (checkpoint === 'effectApplied' && progress === 256) throw new Error('interrupted second list-delete batch');
      },
    });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId: 'lists.delete', idempotencyKey: key,
      input: { id: list, expectedRevision: 1, ...body } }), /interrupted second list-delete batch/u);
    assert.equal(f.gate.ready, false);
    await expected(f.call(boardPath(ids.privateBoard) + '/workspace', editor), 503);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const result = await expected(mutate(f, editor, 'DELETE', listPath(list), 1, body, key), 204);
    assert.equal(result.headers[relationshipParentRevisionHeader], '2');
    assert.equal(result.data, '');
    await expected(mutate(f, other, 'DELETE', listPath(list), 1, body, key), 404);
    await expected(mutate(f, editor, 'DELETE', listPath(list), 1, { ...body, sourceOrderVersion: 9 }, key), 404);
    const rows = await f.db.collection('cards').find({ ...f.scope, id: { $in: idsToMove } }, { promoteLongs: false }).sort({ id: 1 }).toArray();
    assert.equal(rows.length, cardCount);
    for (const [index, row] of rows.entries()) {
      assert.deepEqual([row.id, row.kind, row.listId, row.rank, row.previousListId, row.closed, row.historySequence.toBigInt()],
        [idsToMove[index], 'trash', ids.privateTrash, null, null, index !== 0, safeSequence + 1n + BigInt(index)]);
      assert.equal(row.previousListProvenance.listId, list);
    }
    const preexisting = await f.db.collection('cards').findOne({ ...f.scope, id: ids.trashedCard });
    assert.equal(preexisting.previousListId, null);
    assert.equal(preexisting.previousListProvenance.listId, list);
    const board = await data(f.call(boardPath(ids.privateBoard) + '/workspace', editor));
    assert.deepEqual([board.orderVersion, board.lists.find(({ id }) => id === ids.privateTrash).orderVersion], [2, 2]);
    assert.equal(board.lists.some(({ id }) => id === list), false);
    assert.equal(await f.db.collection('lists').countDocuments({ generationId: f.stagedGenerationId, id: list }), 1);
    assert.equal(await f.db.collection('activities').countDocuments({ ...f.scope, cardId: { $in: idsToMove } }), cardCount);
    assert.equal(await f.db.collection('notifications').countDocuments({ ...f.scope, cardId: { $in: idsToMove } }), 0);
    assert.equal(await f.db.collection('attachments').countDocuments({ ...f.scope, cardId: idsToMove[0] }), 1);
    assert.equal(await f.db.collection('auditEntries').countDocuments({ ...f.scope, resourceId: list, action: 'lists.delete' }), 1);

    await expected(mutate(f, owner, 'PATCH', boardPath(ids.privateBoard) + '/members/' + ids.firstEditor, 1, { role: 'viewer' }), 200);
    await expected(mutate(f, editor, 'DELETE', listPath(list), 1, body, key), 403);
  });
});
