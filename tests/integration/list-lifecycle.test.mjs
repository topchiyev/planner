import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Long } from 'mongodb';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const boardId = ids.privateBoard;
const browse = '/api/v1/boards/' + boardId + '/workspace';
const create = '/api/v1/boards/' + boardId + '/lists';
const listPath = (id) => '/api/v1/lists/' + id;

async function withWorkspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, id) { return cookieOf(await f.login(id)); }

function mutate(f, cookie, method, path, revision, body, key = randomUUID(), headers = {}) {
  return f.call(path, cookie, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'Idempotency-Key': key,
    ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }), ...headers,
  } });
}

async function receipt(pending, status, code) {
  const response = await pending;
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(response.headers['cache-control'], 'no-store');
  if (code) assert.equal(response.data.error.code, code);
  return response.data.data;
}

const finite = (workspace) => workspace.lists.filter(({ kind }) => kind === 'active' || kind === 'closed');
const moveBody = (beforeListId, order, options = {}) => ({
  toBoardId: boardId, beforeListId, sourceOrderVersion: order, destinationOrderVersion: order, ...options,
});

test('direct editors create finite lists and edit metadata independently of placement; system lists are fixed', { timeout: 90_000 }, async () => {
  await withWorkspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const admin = await signIn(f, ids.admin);
    const manager = await signIn(f, ids.projectManager);
    const lists = f.db.collection('lists');
    const longName = 'Legacy ' + 'x'.repeat(160);
    await f.db.collection('boards').updateOne({ ...f.scope, id: boardId }, { $unset: { orderVersion: '' }, $set: { revision: 6 } });
    await lists.updateOne({ ...f.scope, id: ids.privateActiveList },
      { $unset: { orderVersion: '' }, $set: { revision: 4, name: longName, color: 'antique-blue' } });
    const starting = await receipt(f.call(browse, editor), 200);
    assert.deepEqual([starting.orderVersion, finite(starting)[0].orderVersion, finite(starting)[0].color], [1, 4, 'antique-blue']);
    const body = { name: 'Fresh', kind: 'active' };
    await receipt(mutate(f, viewer, 'POST', create, 6, body), 403);
    await receipt(mutate(f, admin, 'POST', create, 6, body), 404);
    await receipt(mutate(f, manager, 'POST', '/api/v1/boards/' + ids.sharedBoard + '/lists', 1, body), 403);
    await receipt(mutate(f, editor, 'POST', create, undefined, body), 422, 'INVALID_REQUEST');
    await receipt(mutate(f, editor, 'POST', create, 6, body, randomUUID(), { 'Idempotency-Key': '' }), 422, 'INVALID_REQUEST');
    await receipt(mutate(f, editor, 'POST', create, 6, { ...body, kind: 'archive' }), 422, 'INVALID_REQUEST');
    await receipt(mutate(f, editor, 'POST', create, 6, { ...body, color: '#000' }), 422, 'INVALID_REQUEST');
    await receipt(mutate(f, editor, 'POST', create, 5, body), 409, 'REVISION_CONFLICT');
    const key = randomUUID();
    const active = await receipt(mutate(f, editor, 'POST', create, 6, { ...body, name: '  Fresh  ' }, key), 201);
    assert.equal(active.list.id[14], '4');
    assert.deepEqual([active.list.name, active.list.kind, active.list.color, active.list.rank, active.list.revision,
      active.list.orderVersion, active.boardRevision, active.boardOrderVersion], ['Fresh', 'active', null, '3072', 1, 1, 7, 2]);
    assert.deepEqual(await receipt(mutate(f, editor, 'POST', create, 6, { ...body, color: null }, key), 201), active);
    await receipt(mutate(f, editor, 'POST', create, 6, { ...body, name: 'Other' }, key), 409, 'IDEMPOTENCY_CONFLICT');
    const closed = await receipt(mutate(f, editor, 'POST', create, 7, { name: 'Finished', kind: 'closed', color: 'berry-red' }), 201);
    assert.deepEqual([closed.list.kind, closed.list.color, closed.list.rank, closed.boardOrderVersion], ['closed', 'berry-red', '4096', 3]);

    for (const id of [ids.privateArchive, ids.privateTrash]) {
      await receipt(mutate(f, editor, 'PATCH', listPath(id), 1, { name: 'Denied' }), 403);
      await receipt(mutate(f, editor, 'POST', listPath(id) + '/move', 1, moveBody(null, 3)), 403);
    }
    const original = listPath(ids.privateActiveList);
    await receipt(mutate(f, viewer, 'PATCH', original, 4, { name: 'Denied' }), 403);
    await receipt(mutate(f, editor, 'PATCH', original, 3, { color: null }), 409, 'REVISION_CONFLICT');
    await receipt(mutate(f, editor, 'PATCH', original, 4, { kind: 'closed' }), 422, 'INVALID_REQUEST');
    await receipt(mutate(f, editor, 'PATCH', original, 4, {}), 422, 'INVALID_REQUEST');
    const cleared = await receipt(mutate(f, editor, 'PATCH', original, 4, { color: null }), 200);
    assert.deepEqual([cleared.list.name, cleared.list.color, cleared.list.revision, cleared.list.orderVersion,
      cleared.boardRevision, cleared.boardOrderVersion], [longName, null, 5, 4, 9, 3]);
    const renamed = await receipt(mutate(f, editor, 'PATCH', listPath(closed.list.id), 1, { name: ' New name ' }), 200);
    assert.deepEqual([renamed.list.name, renamed.list.kind, renamed.list.color, renamed.list.orderVersion, renamed.boardOrderVersion],
      ['New name', 'closed', 'berry-red', 1, 3]);
    assert.deepEqual(await lists.find({ ...f.scope, boardId, kind: { $in: ['archive', 'trash'] } },
      { projection: { _id: 0, name: 1, revision: 1, rank: 1 } }).sort({ name: 1 }).toArray(),
    [{ name: 'Archive', revision: 1, rank: null }, { name: 'Trash', revision: 1, rank: null }]);
    assert.equal((await lists.findOne({ generationId: f.stagedGenerationId, id: ids.privateActiveList })).name, 'To do');
  });
});

test('finite list moves retain card placement and require current ordered scope and editor authority on replay', { timeout: 90_000 }, async () => {
  await withWorkspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const owner = await signIn(f, ids.privateOwner);
    const [left, anchor, moving] = [ids.privateActiveList, ids.privateClosedList, fixtureId(5000)];
    await f.insert('lists', moving, { name: 'Moving list', boardId, kind: 'closed', rank: '9007199254741011' });
    const lists = f.db.collection('lists');
    for (const [id, value] of [[left, 9007199254741010n], [anchor, 9007199254741011n]]) {
      await lists.updateOne({ ...f.scope, id }, { $set: { rank: Long.fromBigInt(value) } });
    }
    const cards = f.db.collection('cards');
    const original = await cards.find({ ...f.scope, boardId }, { promoteLongs: false }).sort({ id: 1 }).toArray();
    const move = (revision, before, order, options, key) =>
      mutate(f, editor, 'POST', listPath(moving) + '/move', revision, moveBody(before, order, options), key);
    await receipt(move(1, anchor, 2), 409, 'LIST_ORDER_CONFLICT');
    await receipt(move(1, anchor, 1, { destinationOrderVersion: 2 }), 409, 'LIST_ORDER_CONFLICT');
    for (const id of [ids.privateArchive, ids.sharedActiveList, fixtureId(5001)]) await receipt(move(1, id, 1), 409, 'LIST_ORDER_CONFLICT');
    await receipt(move(1, null, 1, { toBoardId: ids.sharedBoard }), 409, 'LIST_ORDER_CONFLICT');
    await receipt(move(1, moving, 1), 422, 'INVALID_LIST_ANCHOR');
    assert.deepEqual(finite(await receipt(f.call(browse, editor), 200)).map(({ id, rank }) => [id, rank]),
      [[left, '9007199254741010'], [anchor, '9007199254741011'], [moving, '9007199254741011']]);
    const key = randomUUID();
    const moved = await receipt(move(1, anchor, 1, {}, key), 200);
    assert.deepEqual([moved.list.revision, moved.list.rank, moved.list.orderVersion, moved.boardRevision, moved.boardOrderVersion], [2, '2048', 1, 2, 2]);
    assert.deepEqual(await receipt(move(1, anchor, 1, {}, key), 200), moved);
    assert.deepEqual(finite(await receipt(f.call(browse, editor), 200)).map(({ id, rank }) => [id, rank]),
      [[left, '1024'], [moving, '2048'], [anchor, '3072']]);
    await receipt(move(1, null, 2), 409, 'REVISION_CONFLICT');

    for (const [id, value] of [[left, 2047n], [anchor, 2048n], [moving, 2048n]]) {
      await lists.updateOne({ ...f.scope, id }, { $set: { rank: Long.fromBigInt(value) } });
    }
    const second = await receipt(move(2, anchor, 2), 200);
    assert.deepEqual([second.list.revision, second.list.rank, second.list.orderVersion, second.boardOrderVersion], [3, '2048', 1, 3]);
    assert.deepEqual(await cards.find({ ...f.scope, boardId }, { promoteLongs: false }).sort({ id: 1 }).toArray(), original);
    const noop = await receipt(move(3, anchor, 3), 200);
    assert.deepEqual([noop.list.revision, noop.boardRevision, noop.boardOrderVersion], [3, 3, 3]);

    await receipt(mutate(f, owner, 'PATCH', '/api/v1/boards/' + boardId + '/members/' + ids.firstEditor, 1,
      { role: 'viewer', canComment: false }), 200);
    await receipt(move(1, anchor, 1, {}, key), 403);
    assert.equal((await receipt(f.call(browse, editor), 200)).board.permissions.canEdit, false);
  });
});

test('an interrupted rank update recovers as one journaled list move and one scoped invalidation', { timeout: 90_000 }, async () => {
  await withWorkspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const token = readSessionCookie(editor);
    const moving = ids.privateClosedList;
    const body = moveBody(ids.privateActiveList, 1);
    const key = randomUUID();
    const journal = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), 'web', key),
      checkpoint(checkpoint, progress) {
        if (checkpoint === 'effectApplied' && progress === 0) throw new Error('interrupted list move');
      },
    });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId: 'lists.move', idempotencyKey: key,
      input: { id: moving, expectedRevision: 1, ...body } }), /interrupted list move/u);
    assert.equal(f.gate.ready, false);
    await receipt(f.call(browse, editor), 503);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const retried = await receipt(mutate(f, editor, 'POST', listPath(moving) + '/move', 1, body, key), 200);
    assert.deepEqual([retried.list.revision, retried.boardRevision, retried.boardOrderVersion], [2, 2, 2]);
    assert.deepEqual(finite(await receipt(f.call(browse, editor), 200)).map(({ id }) => id), [moving, ids.privateActiveList]);
    const audits = await f.db.collection('auditEntries').find({ ...f.scope, action: 'lists.move', resourceId: moving }).toArray();
    assert.equal(audits.length, 1);
    const events = await f.db.collection('events').find({ ...f.scope, commandId: audits[0].commandId }).toArray();
    assert.deepEqual(events.map(({ boardId, kind, payload }) => [boardId, kind, payload]), [[boardId, 'board.invalidated', {}]]);
  });
});
