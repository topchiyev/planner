import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Long } from 'mongodb';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const board = (id) => '/api/v1/boards/' + id;
const list = (id) => '/api/v1/lists/' + id;
const card = (id) => '/api/v1/cards/' + id;

async function workspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, id) {
  const loggedIn = await f.login(id);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

function post(f, cookie, path, revision, body, key = randomUUID()) {
  return f.call(path, cookie, { method: 'POST', body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'If-Match': `"${revision}"`, 'Idempotency-Key': key,
  } });
}

async function response(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data).slice(0, 1000));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result.data;
}

const ranked = (f, generationId, listId, kind = 'board') => f.db.collection('cards').find({ generationId, listId, kind })
  .sort({ rank: 1, id: 1 }).toArray();
const get = (f, collection, id) => f.db.collection(collection).findOne({ ...f.scope, id });

function journalOptions(f, token, key, checkpoint, origin = 'web') {
  return {
    operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), origin, key),
    checkpoint,
  };
}

test('finite list sorting uses folded name ties, two date directions and exact independent versions', { timeout: 100_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const other = await signIn(f, ids.admin);
    const id = ids.privateActiveList;
    const idsInList = [ids.activeCard, fixtureId(5000), fixtureId(5001), fixtureId(5002), fixtureId(5003)];
    const [existing, sharp, double, decomposed, composed] = idsInList;
    const names = ['Zulu', 'Fuß', 'FUSS', 'A\u030Angström', 'Ångström'];
    const dates = [null, '2026-03-19T13:13:59.719Z', '2026-03-19T13:13:59.719Z', '2026-02-01T22:00:00.000Z', null];
    const slots = ['-9223372036854775808', '-9', '0', '4', '9223372036854775807'];
    const created = ['2026-01-20', '2026-01-15', '2026-01-17', '2026-01-16', '2026-01-16'].map((day) => day + 'T10:00:00.000Z');
    await f.db.collection('cards').updateOne({ ...f.scope, id: existing }, { $set: { name: names[0], rank: Long.fromString(slots[0]), dueDate: null, createdAt: new Date(created[0]) } });
    for (let i = 1; i < idsInList.length; i++) {
      await f.insert('cards', idsInList[i], { boardId: ids.privateBoard, listId: id, type: 'project', kind: 'board',
        name: names[i], dueDate: dates[i], rank: slots[i], closed: i === 3, createdAt: created[i] });
    }
    const archived = await get(f, 'cards', ids.archivedStory);
    await response(post(f, viewer, list(id) + '/sort', 1, { field: 'name', direction: 'asc', sourceOrderVersion: 1 }), 403);
    await response(post(f, other, list(id) + '/sort', 1, { field: 'name', direction: 'asc', sourceOrderVersion: 1 }), 404);
    await response(post(f, editor, list(ids.privateArchive) + '/sort', 1, { field: 'name', direction: 'asc', sourceOrderVersion: 1 }), 403);
    await response(post(f, editor, list(id) + '/sort', 1, { field: 'unknown', direction: 'asc', sourceOrderVersion: 1 }), 422);

    async function sort(field, direction, revision, version = revision, key) {
      return post(f, editor, list(id) + '/sort', revision, { field, direction, sourceOrderVersion: version }, key);
    }
    async function order(expected) {
      const current = await ranked(f, f.generationId, id);
      assert.deepEqual(current.map(({ id }) => id), expected);
      assert.deepEqual(current.map(({ rank }) => String(rank)), slots);
    }
    const key = randomUUID();
    const interruption = new Error('test interruption after first durable sort effect');
    const journal = new CommandJournal(f.gate, f.db, f.installationId, journalOptions(f, readSessionCookie(editor), key, (point, index) => {
      if (point === 'effectApplied' && index === 0) throw interruption;
    }));
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, idempotencyKey: key, operationId: 'lists.sort',
      input: { id, expectedRevision: 1, sourceOrderVersion: 1, field: 'name', direction: 'asc' } }), (error) => error === interruption);
    const interrupted = await ranked(f, f.generationId, id);
    assert.equal(interrupted.filter(({ revision }) => revision === 2).length, 1);
    assert.equal((await get(f, 'lists', id)).revision, 1);
    await response(f.call(board(ids.privateBoard) + '/cards', editor), 503);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const sorted = (await response(sort('name', 'asc', 1, 1, key), 200)).data;
    assert.deepEqual(sorted.source, { listId: id, revision: 2, orderVersion: 2 });
    assert.equal(sorted.changedCount, 5);
    await order([decomposed, composed, sharp, double, existing]);
    assert.ok((await ranked(f, f.generationId, id)).every(({ revision }) => revision === 2));
    assert.equal(await f.db.collection('events').countDocuments(f.scope), 1);
    assert.deepEqual((await response(sort('name', 'asc', 1, 1, key), 200)).data, sorted);
    await response(sort('name', 'desc', 1), 409, 'REVISION_CONFLICT');
    await response(sort('name', 'desc', 2, 1), 409, 'CARD_ORDER_CONFLICT');
    const beforeNoop = await f.db.collection('events').countDocuments(f.scope);
    const noop = (await response(sort('name', 'asc', 2), 200)).data;
    assert.deepEqual(noop, { source: sorted.source, changedCount: 0 });
    assert.equal(await f.db.collection('events').countDocuments(f.scope), beforeNoop);

    await response(sort('name', 'desc', 2), 200);
    await order([existing, sharp, double, decomposed, composed]);
    await response(sort('dueDate', 'asc', 3), 200);
    await order([decomposed, sharp, double, existing, composed]);
    await response(sort('dueDate', 'desc', 4), 200);
    await order([sharp, double, decomposed, existing, composed]);
    await response(sort('createdAt', 'asc', 5), 200);
    await order([sharp, decomposed, composed, double, existing]);
    await response(sort('createdAt', 'desc', 6), 200);
    await order([existing, double, decomposed, composed, sharp]);

    assert.deepEqual(await get(f, 'cards', ids.archivedStory), archived);
    assert.deepEqual([(await get(f, 'boards', ids.privateBoard)).revision, (await get(f, 'boards', ids.privateBoard)).orderVersion], [1, 1]);
    assert.equal((await get(f, 'cards', decomposed)).closed, true);
    assert.equal((await f.db.collection('cards').findOne({ generationId: f.stagedGenerationId, id: existing })).revision, 1);
  });
});

test('bulk archive recovers over multiple journal batches with prior placement, same-rank ID ordering and no notifications', { timeout: 140_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const source = ids.privateClosedList;
    const archive = ids.privateArchive;
    const boardId = ids.privateBoard;
    const createdAt = new Date('2026-01-15T10:30:45.000Z');
    const cards = Array.from({ length: 270 }, (_, index) => {
      const id = fixtureId(7000 + index);
      return { _id: workspaceKey(f.generationId, id), ...f.scope, id, revision: 1, createdAt, boardId,
        listId: source, type: 'project', kind: 'board', name: 'Archived batch card ' + index,
        rank: Long.fromNumber(Math.floor(index / 2)), closed: index !== 0, dueDate: createdAt, dueDateCompleted: true,
        stopwatch: { startedAt: null, total: 17 } };
    });
    await f.db.collection('cards').insertMany(cards);
    await f.insert('cardFollows', fixtureId(7600), { cardId: cards[0].id, userId: ids.viewer, isPermanent: true });
    await f.insert('boardFollows', fixtureId(7601), { boardId, userId: ids.viewer });
    await f.insert('attachments', fixtureId(7602), { cardId: cards[0].id, kind: 'link', url: 'https://example.test/', name: 'Keep reference' });
    const linked = await f.insert('tasks', fixtureId(7603), { checklistId: ids.checklist, linkedCardId: cards[0].id, completed: false });
    const linkedBefore = await get(f, 'tasks', linked);
    const body = { archiveListId: archive, sourceOrderVersion: 1, destinationOrderVersion: 1 };
    const path = list(source) + '/archive-cards';
    await response(post(f, viewer, path, 1, body), 403);
    await response(post(f, editor, list(ids.privateActiveList) + '/archive-cards', 1, body), 422, 'ARCHIVE_CARDS_SOURCE');
    await response(post(f, editor, path, 1, { ...body, archiveListId: ids.sharedArchive }), 409, 'CARD_ORDER_CONFLICT');
    await response(post(f, editor, path, 1, { ...body, destinationOrderVersion: 2 }), 409, 'CARD_ORDER_CONFLICT');

    const key = randomUUID();
    const request = { actorId: ids.firstEditor, operationId: 'lists.archiveCards', idempotencyKey: key,
      input: { id: source, expectedRevision: 1, ...body } };
    const interrupted = new Error('test interruption between archive batches');
    const journal = new CommandJournal(f.gate, f.db, f.installationId, journalOptions(f, readSessionCookie(editor), key, (point, index) => {
      if (point === 'effectApplied' && index === 256) throw interrupted;
    }, 'mcp'));
    await assert.rejects(journal.execute(request), (error) => error === interrupted);
    assert.equal(f.gate.ready, false);
    await response(f.call(board(boardId) + '/workspace', editor), 503);
    const prepared = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    assert.equal(prepared.status, 'prepared');
    assert.ok(prepared.manifest.length >= 3);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const receipt = (await response(post(f, editor, path, 1, body, key), 200)).data;
    assert.deepEqual(receipt, {
      source: { listId: source, revision: 2, orderVersion: 2 },
      destination: { listId: archive, revision: 2, orderVersion: 2 }, archivedCount: cards.length,
    });
    const history = await f.db.collection('cards').find({ ...f.scope, listId: archive, kind: 'archive' })
      .sort({ listChangedAt: -1, historySequence: -1, id: -1 }).toArray();
    assert.deepEqual(history.slice(0, cards.length).map(({ id }) => id), cards.map(({ id }) => id));
    assert.deepEqual([history[0].rank, history[0].closed, history[0].previousListId, history[0].stopwatch.total,
      history[0].dueDateCompleted], [null, false, source, 17, true]);
    assert.ok(history.slice(0, cards.length).every(({ listChangedAt }) => listChangedAt.valueOf() === history[0].listChangedAt.valueOf()));
    assert.deepEqual((await ranked(f, f.generationId, source)).map(({ id }) => id), []);
    assert.ok(await get(f, 'cardFollows', fixtureId(7600)));
    assert.ok(await get(f, 'attachments', fixtureId(7602)));
    assert.deepEqual(await get(f, 'tasks', linked), linkedBefore);
    assert.equal(await f.db.collection('activities').countDocuments({ ...f.scope, commandId: prepared.id, kind: 'moveCard' }), cards.length);
    assert.equal(await f.db.collection('notifications').countDocuments(f.scope), 0);
    const events = await f.db.collection('events').find({ ...f.scope, commandId: prepared.id }).toArray();
    assert.deepEqual(events.map(({ boardId, kind, payload }) => [boardId, kind, payload]), [[boardId, 'board.invalidated', {}]]);
    assert.equal((await get(f, 'boards', boardId)).orderVersion, 1);
    assert.equal((await get(f, 'boards', boardId)).historySequence.toString(), history[0].historySequence.toString());
    await response(post(f, editor, path, 2, { ...body, sourceOrderVersion: 2, destinationOrderVersion: 2 }), 200);
    assert.equal(await f.db.collection('events').countDocuments(f.scope), 1);
  });
});

test('trash clear confirms the exact list, keeps its roots and protects links across recoveries', { timeout: 135_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const owner = await signIn(f, ids.privateOwner);
    const viewer = await signIn(f, ids.viewer);
    const admin = await signIn(f, ids.admin);
    const boardId = ids.privateBoard;
    const trash = ids.privateTrash;
    const victim = ids.trashedCard;
    const originalName = 'Legacy trashed target ' + 'x'.repeat(650) + ' suffix';
    await f.db.collection('cards').updateOne({ ...f.scope, id: victim }, { $set: {
      name: originalName, closed: true, historySequence: Long.fromBigInt(9223372036854775807n),
    } });
    const ownTask = fixtureId(8010);
    const victimChecklist = fixtureId(8011);
    const externalChecklist = fixtureId(8012);
    const externalTask = fixtureId(8013);
    const boardFeed = fixtureId(8014);
    const victimFeed = fixtureId(8015);
    const keepLabel = fixtureId(8016);
    const labelJoin = fixtureId(8017);
    await f.insert('tasks', ownTask, { checklistId: ids.checklist, linkedCardId: victim, completed: true, name: originalName });
    await f.insert('checklists', victimChecklist, { cardId: victim, name: 'Victim group', rank: '1' });
    await f.insert('checklists', externalChecklist, { cardId: ids.sharedTarget, name: 'Other board group', rank: '1' });
    await f.insert('tasks', externalTask, { checklistId: externalChecklist, linkedCardId: victim, completed: true, name: originalName });
    await f.insert('activities', boardFeed, { boardId, cardId: null });
    await f.insert('activities', victimFeed, { boardId, cardId: victim });
    await f.insert('labels', keepLabel, { boardId, name: 'Board-owned label', rank: '1' });
    await f.insert('cardLabels', labelJoin, { cardId: victim, labelId: keepLabel });
    const boardNotice = await f.insert('notifications', fixtureId(8018), { boardId, cardId: null, recipientId: ids.viewer });
    const cardNotice = await f.insert('notifications', fixtureId(8019), { boardId, cardId: victim, recipientId: ids.viewer });
    const createdAt = new Date('2026-01-16T10:30:45.000Z');
    await f.db.collection('tasks').insertMany(Array.from({ length: 270 }, (_, index) => {
      const id = fixtureId(8100 + index);
      return { _id: workspaceKey(f.generationId, id), ...f.scope, id, revision: 1, createdAt, checklistId: victimChecklist };
    }));
    const clear = board(boardId) + '/trash/clear';
    const body = { trashListId: trash, trashOrderVersion: 1, confirmed: true };
    await response(post(f, viewer, clear, 1, body), 403);
    await response(post(f, admin, clear, 1, body), 404);
    await response(post(f, owner, clear, 1, { ...body, confirmed: false }), 422);
    await response(post(f, owner, clear, 1, { ...body, trashListId: ids.sharedTrash }), 409, 'CARD_ORDER_CONFLICT');
    await response(post(f, owner, clear, 1, { ...body, trashOrderVersion: 2 }), 409, 'CARD_ORDER_CONFLICT');
    await response(post(f, owner, clear, 2, body), 409, 'REVISION_CONFLICT');
    await f.db.collection('cards').updateOne({ ...f.scope, id: victim }, { $set: { name: 'x'.repeat(2 * 1024 * 1024) } });
    await response(post(f, editor, clear, 1, body), 422, 'TRASH_CLEAR_DATA_LIMIT');
    assert.equal(f.gate.ready, true);
    assert.equal((await get(f, 'tasks', ownTask)).linkedCardId, victim);
    await f.db.collection('cards').updateOne({ ...f.scope, id: victim }, { $set: { name: originalName } });

    // A project manager keeps this board through the project without a direct membership.
    await f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId, userId: ids.privateOwner });
    const key = randomUUID();
    const intent = { actorId: ids.privateOwner, operationId: 'lists.clearTrash', idempotencyKey: key,
      input: { id: boardId, expectedRevision: 1, ...body } };
    const token = readSessionCookie(owner);
    await assert.rejects(new CommandJournal(f.gate, f.db, f.installationId, journalOptions(f, token, key, undefined, 'mcp')).execute(intent),
      { statusCode: 403 });
    const interrupt = (message, checkpoints) => {
      const error = new Error(message);
      return { error, journal: new CommandJournal(f.gate, f.db, f.installationId, journalOptions(f, token, key, (point, index) => {
        if (checkpoints(point, index)) throw error;
      })) };
    };
    const prepare = interrupt('test interruption after clear preparation', (point) => point === 'prepared');
    await assert.rejects(prepare.journal.execute(intent), (error) => error === prepare.error);
    assert.equal(f.gate.ready, false);
    const prepared = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    assert.equal(prepared.status, 'prepared');
    assert.ok(prepared.manifest.length >= 2);
    assert.equal(await f.db.collection('tasks').countDocuments({ ...f.scope, checklistId: victimChecklist }), 270);
    const apply = interrupt('test interruption between clear batches', (point, index) => point === 'effectApplied' && index === 257);
    await assert.rejects(apply.journal.recover(), (error) => error === apply.error);
    const remaining = await f.db.collection('tasks').countDocuments({ ...f.scope, checklistId: victimChecklist });
    assert.ok(remaining > 0 && remaining < 270);
    await response(f.call(card(victim), owner), 503);
    const commit = interrupt('test interruption after durable clear commit', (point) => point === 'committed');
    await assert.rejects(commit.journal.recover(), (error) => error === commit.error);
    assert.equal((await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key })).status, 'committed');
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const receipt = (await response(post(f, owner, clear, 1, body, key), 200)).data;
    assert.deepEqual(receipt, { trash: { listId: trash, revision: 2, orderVersion: 2 }, clearedCount: 1 });
    await response(post(f, viewer, clear, 1, body, key), 403);
    await response(f.call(card(victim), owner), 404);
    assert.equal((await get(f, 'boards', boardId)).historySequence.toString(), '9223372036854775807');
    assert.equal((await get(f, 'boards', boardId)).orderVersion, 1);
    for (const [collection, id] of [['activities', boardFeed], ['notifications', boardNotice], ['labels', keepLabel], ['lists', trash],
      ['cards', ids.archivedStory], ['fieldGroups', ids.fieldGroup]]) assert.ok(await get(f, collection, id), collection);
    for (const [collection, id] of [['activities', victimFeed], ['notifications', cardNotice], ['cardLabels', labelJoin], ['cards', victim],
      ['checklists', victimChecklist]]) assert.equal(await get(f, collection, id), null, collection);
    assert.equal(await f.db.collection('tasks').countDocuments({ ...f.scope, checklistId: victimChecklist }), 0);
    assert.ok(await f.db.collection('cards').findOne({ generationId: f.stagedGenerationId, id: victim }));
    for (const taskId of [ownTask, externalTask]) {
      const row = await get(f, 'tasks', taskId);
      assert.deepEqual([row.linkedCardId, row.linkedUnavailable, row.name, row.completed], [null, true, null, null]);
      assert.deepEqual(row.linkedUnavailableProvenance, { name: originalName, id: victim, completed: true });
    }
    const internal = await openActiveWorkspace(f.db, f.installationId);
    assert.equal(Object.hasOwn(await internal.read('tasks', ownTask), 'linkedUnavailableProvenance'), false);
    for (const [ownerCard, caller, taskId] of [[ids.activeCard, viewer, ownTask], [ids.sharedTarget, editor, externalTask]]) {
      const tasks = (await response(f.call(card(ownerCard) + '/checklists', caller), 200)).data.flatMap(({ tasks }) => tasks);
      assert.deepEqual(tasks.filter(({ id }) => id === taskId).map(({ kind, linkedCard, completed }) => [kind, linkedCard, completed]),
        [['unavailable', undefined, undefined]]);
    }
    for (const [collection, id] of [['cards', ids.activeCard], ['cards', ids.sharedTarget],
      ['checklists', ids.checklist], ['checklists', externalChecklist]]) assert.equal((await get(f, collection, id)).revision, 2);
    const events = await f.db.collection('events').find({ ...f.scope, commandId: prepared.id }).sort({ ordinal: 1 }).toArray();
    assert.deepEqual(events.map(({ boardId, kind, payload }) => [boardId, kind, payload]),
      [[boardId, 'board.invalidated', {}], [ids.sharedBoard, 'board.invalidated', {}]]);
    assert.equal(await f.db.collection('auditEntries').countDocuments({ ...f.scope, commandId: prepared.id }), 1);
  });
});
