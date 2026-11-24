import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Long } from 'mongodb';
import { relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { workspaceFixtureInstant } from '../fixtures/planner-workspace.ts';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const project = (id) => '/api/v1/projects/' + id;
const board = (id) => '/api/v1/boards/' + id;

async function withWorkspace(run) {
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

function mutate(f, cookie, method, path, revision, body, key = randomUUID(), headers = {}) {
  return f.call(path, cookie, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'Idempotency-Key': key,
    ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }), ...headers,
  } });
}

async function response(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result;
}

test('board creation, dense moves and settings preserve both scoped authorities and independent order versions', { timeout: 90_000 }, async () => {
  await withWorkspace(async (f) => {
    const owner = await signIn(f, ids.privateOwner);
    const editor = await signIn(f, ids.firstEditor);
    const admin = await signIn(f, ids.admin);
    const fixtureBoard = ids.privateBoard;
    const projectPath = project(ids.privateProject);
    const boards = projectPath + '/boards';
    assert.equal((await response(f.call(projectPath, owner), 200)).data.data.boardOrderVersion, 1);
    await response(mutate(f, editor, 'POST', boards, 1, { name: 'Denied' }), 403);
    await response(mutate(f, admin, 'POST', project(ids.sharedProject) + '/boards', 1, { name: 'Denied' }), 403);
    await response(mutate(f, owner, 'POST', boards, undefined, { name: 'Missing precondition' }), 422, 'INVALID_REQUEST');
    await response(mutate(f, owner, 'POST', boards, 1, { name: 'x'.repeat(129) }), 422, 'INVALID_REQUEST');
    await response(mutate(f, owner, 'POST', boards, 1, { name: 'Wrong origin' }, randomUUID(), { Origin: 'https://other.invalid' }), 403);
    const key = randomUUID();
    const created = (await response(mutate(f, owner, 'POST', boards, 1, { name: '  Board alpha  ' }, key), 201)).data.data;
    const alpha = created.board.id;
    assert.equal(created.board.name, 'Board alpha');
    assert.equal(created.board.revision, 1);
    assert.deepEqual([created.projectRevision, created.projectBoardOrderVersion], [2, 2]);
    assert.deepEqual((await response(mutate(f, owner, 'POST', boards, 1, { name: 'Board alpha' }, key), 201)).data.data, created);
    await response(mutate(f, owner, 'POST', boards, 1, { name: 'Different' }, key), 409, 'IDEMPOTENCY_CONFLICT');
    await response(mutate(f, owner, 'POST', boards, 1, { name: 'Parent stale' }), 409, 'REVISION_CONFLICT');
    const [lists, direct, preferences] = await Promise.all([
      f.db.collection('lists').find({ ...f.scope, boardId: alpha }).sort({ kind: 1 }).toArray(),
      f.db.collection('boardMembers').find({ ...f.scope, boardId: alpha }).toArray(),
      f.db.collection('boardPreferences').find({ ...f.scope, boardId: alpha }).toArray(),
    ]);
    assert.deepEqual(lists.map(({ kind, name, rank, revision }) => ({ kind, name, rank, revision })),
      [{ kind: 'archive', name: 'Archive', rank: null, revision: 1 }, { kind: 'trash', name: 'Trash', rank: null, revision: 1 }]);
    assert.deepEqual(direct.map(({ userId, role, canComment }) => ({ userId, role, canComment })),
      [{ userId: ids.privateOwner, role: 'editor', canComment: null }]);
    assert.deepEqual(preferences.map(({ defaultView, defaultCardType, showCardCount }) => ({ defaultView, defaultCardType, showCardCount })),
      [{ defaultView: 'kanban', defaultCardType: null, showCardCount: false }]);
    await response(f.call(board(alpha), editor), 404);

    const beta = (await response(mutate(f, owner, 'POST', boards, 2, { name: 'Board beta' }), 201)).data.data.board.id;
    for (const [i, id] of [fixtureBoard, alpha, beta].entries()) {
      await f.db.collection('boards').updateOne({ ...f.scope, id }, { $set: { rank: Long.fromBigInt(9223372036854775805n + BigInt(i)) } });
    }
    const move = (revision, beforeBoardId, projectBoardOrderVersion, actor = owner) =>
      mutate(f, actor, 'POST', board(beta) + '/move', revision, { beforeBoardId, projectBoardOrderVersion });
    await response(move(1, alpha, 2), 409, 'BOARD_ORDER_CONFLICT');
    await response(move(1, ids.sharedBoard, 3), 409, 'BOARD_ORDER_CONFLICT');
    await response(move(1, fixtureId(5000), 3), 409, 'BOARD_ORDER_CONFLICT');
    await response(move(1, beta, 3), 409, 'BOARD_ORDER_CONFLICT');
    const unchanged = (await response(move(1, null, 3), 200)).data.data;
    assert.deepEqual([unchanged.board.revision, unchanged.projectRevision, unchanged.projectBoardOrderVersion], [1, 3, 3]);
    const moved = (await response(move(1, alpha, 3), 200)).data.data;
    assert.deepEqual([moved.board.revision, moved.projectRevision, moved.projectBoardOrderVersion], [2, 4, 4]);
    await response(move(1, null, 4), 409, 'REVISION_CONFLICT');
    const placement = (await response(f.call(boards, owner), 200)).data.data;
    assert.deepEqual(placement.map(({ id, rank, revision }) => [id, rank, revision]),
      [[fixtureBoard, '1024', 2], [beta, '2048', 2], [alpha, '3072', 2]]);

    await f.db.collection('boards').updateOne({ ...f.scope, id: fixtureBoard }, { $set: { defaultView: 'grid', orderVersion: 18 } });
    const options = { name: 'Settings board', defaultCardType: 'story', restrictedCardType: 'story',
      showCreator: true, showCardAge: true, showCardCount: true, expandChecklists: true };
    await response(mutate(f, editor, 'PATCH', board(fixtureBoard), 2, options), 403);
    await response(mutate(f, admin, 'PATCH', board(ids.sharedBoard), 1, options), 403);
    await response(mutate(f, owner, 'PATCH', board(fixtureBoard), 1, options), 409, 'REVISION_CONFLICT');
    await response(mutate(f, owner, 'PATCH', board(fixtureBoard), 2, { orderVersion: 19 }), 422);
    const updated = (await response(mutate(f, owner, 'PATCH', board(fixtureBoard), 2, options), 200)).data.data;
    assert.equal(updated.board.name, options.name);
    assert.deepEqual(updated.preferences, { ...Object.fromEntries(Object.entries(options).filter(([field]) => field !== 'name')),
      revision: 1, defaultView: 'grid' });
    const boot = (await response(f.call(board(fixtureBoard) + '/workspace', editor), 200)).data.data;
    assert.deepEqual([boot.orderVersion, boot.project.boardOrderVersion, boot.project.revision], [18, 4, 4]);
    assert.deepEqual(boot.preferences, updated.preferences);
    assert.equal((await f.db.collection('cards').findOne({ ...f.scope, id: ids.activeCard })).type, 'project');
    const none = (await response(mutate(f, owner, 'PATCH', board(fixtureBoard), 3, { restrictedCardType: null, defaultView: 'list' }), 200)).data.data;
    assert.equal(none.preferences.restrictedCardType, null);
    assert.equal(none.preferences.defaultView, 'list');
  });
});

test('project removal and board creation serialize on an empty project', { timeout: 90_000 }, async () => {
  await withWorkspace(async (f) => {
    const owner = await signIn(f, ids.privateOwner);
    const name = 'Previously empty project';
    const created = (await response(mutate(f, owner, 'POST', '/api/v1/projects', undefined, { name, type: 'private' }), 201)).data.data;
    const path = project(created.id);
    const [addition, removal] = await Promise.all([
      mutate(f, owner, 'POST', path + '/boards', 1, { name: 'Racing board' }),
      mutate(f, owner, 'DELETE', path, 1, { name }),
    ]);
    const count = await f.db.collection('boards').countDocuments({ ...f.scope, projectId: created.id });
    if (addition.status === 201) assert.deepEqual([removal.status, count], [409, 1]);
    else assert.deepEqual([addition.status, removal.status, count], [404, 204, 0]);
  });
});

test('populated board deletion recovers across batches and redacts surviving linked tasks and receipts', { timeout: 100_000 }, async () => {
  await withWorkspace(async (f) => {
    const manager = await signIn(f, ids.projectManager);
    const siteAdmin = await signIn(f, ids.admin);
    const editor = await signIn(f, ids.firstEditor);
    const survivingOwner = await signIn(f, ids.privateOwner);
    const target = ids.sharedBoard;
    const linked = ids.sharedTarget;
    const name = 'Imported board ' + 'x'.repeat(165) + '  ';
    await f.db.collection('boards').updateOne({ ...f.scope, id: target }, { $set: { name } });
    const rows = new Map([
      ['labels', { boardId: target, name: 'Board label', rank: '1' }],
      ['boardPreferences', { boardId: target, defaultView: 'list' }],
      ['boardFollows', { boardId: target, userId: ids.firstEditor }],
      ['cardFollows', { cardId: linked, userId: ids.firstEditor }],
      ['cardAssignees', { cardId: linked, userId: ids.firstEditor }],
      ['comments', { cardId: linked, boardId: target, authorId: ids.firstEditor, text: 'Delete comment' }],
      ['activities', { cardId: linked, boardId: ids.privateBoard }],
      ['notifications', { boardId: target, cardId: null, recipientId: ids.firstEditor }],
      ['attachments', { cardId: linked, kind: 'link', url: 'https://example.test/', name: 'Board link' }],
      ['checklists', { cardId: linked, name: 'Board checklist', rank: '1' }],
      ['fieldGroups', { scopeType: 'board', scopeId: target, name: 'Board group', rank: '1' }],
    ]);
    const deleted = new Map();
    for (const [collection, fields] of rows) {
      const id = randomUUID();
      deleted.set(collection, id);
      await f.insert(collection, id, fields);
      await f.insert(collection, id, fields, f.stagedGenerationId);
    }
    await f.insert('cardLabels', fixtureId(7100), { cardId: linked, labelId: deleted.get('labels') });
    const projectTemplate = fixtureId(7101);
    const templateDefinition = fixtureId(7102);
    const group = fixtureId(7103);
    await f.insert('fieldGroups', projectTemplate, { scopeType: 'project', scopeId: ids.sharedProject, name: 'Keep template', rank: '1' });
    await f.insert('fieldDefinitions', templateDefinition, { fieldGroupId: projectTemplate, name: 'Keep definition', rank: '1' });
    await f.insert('fieldGroups', group, { scopeType: 'card', scopeId: linked, name: 'Instance', templateGroupId: projectTemplate, rank: '1' });
    await f.insert('fieldValues', fixtureId(7104), { cardId: linked, fieldGroupId: group, fieldDefinitionId: templateDefinition, value: 'Delete value' });
    for (const [i, kind] of ['archive', 'trash'].entries()) {
      await f.insert('cards', fixtureId(7106 + i), { boardId: target, kind, listId: kind === 'archive' ? ids.sharedArchive : ids.sharedTrash,
        name: 'Historical card', type: 'story', rank: null });
    }
    const date = new Date(workspaceFixtureInstant);
    const batch = Array.from({ length: 270 }, (_, index) => {
      const id = fixtureId(8000 + index);
      return { id, _id: workspaceKey(f.generationId, id), ...f.scope, revision: 1, createdAt: date,
        checklistId: deleted.get('checklists'), name: 'Board task ' + index };
    });
    await f.db.collection('tasks').insertMany(batch);
    const extraTask = fixtureId(7108);
    await f.insert('tasks', extraTask, { checklistId: ids.checklist, linkedCardId: linked, completed: true, rank: '2048' });
    const historicalActivity = await f.insert('activities', fixtureId(7109), { boardId: target, cardId: ids.activeCard });
    const historicalNotice = await f.insert('notifications', fixtureId(7110), { boardId: target, cardId: ids.activeCard, recipientId: ids.firstEditor });
    await response(mutate(f, siteAdmin, 'DELETE', board(target), 1, { name }), 403);
    await response(mutate(f, editor, 'DELETE', board(target), 1, { name }), 403);
    await response(mutate(f, manager, 'DELETE', board(target), 1, { name: name.trim() }), 422, 'BOARD_NAME_MISMATCH');
    await response(mutate(f, manager, 'DELETE', board(target), 2, { name }), 409, 'REVISION_CONFLICT');

    const key = randomUUID();
    const token = readSessionCookie(manager);
    const intent = { actorId: ids.projectManager, operationId: 'boards.delete', idempotencyKey: key,
      input: { id: target, name, expectedRevision: 1 } };
    const operations = (origin) => createRelationshipJournalOperations(f.db,
      () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), origin, key);
    await assert.rejects(new CommandJournal(f.gate, f.db, f.installationId, { operations: operations('mcp') }).execute(intent),
      { statusCode: 403 });
    const interruption = new Error('test interruption between effect batches');
    const journal = new CommandJournal(f.gate, f.db, f.installationId, { operations: operations('web'), checkpoint(point, index) {
      if (point === 'effectApplied' && index === 256) throw interruption;
    } });
    await assert.rejects(journal.execute(intent), (error) => error === interruption);
    assert.equal(f.gate.ready, false);
    await response(f.call(board(target), manager), 503);
    assert.ok(await f.db.collection('boards').findOne({ ...f.scope, id: target }));
    assert.equal(await f.db.collection('auditEntries').countDocuments({ ...f.scope, action: 'boards.delete' }), 0);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const receipt = await response(mutate(f, manager, 'DELETE', board(target), 1, { name }, key), 204);
    assert.equal(receipt.data, '');
    assert.equal(receipt.headers[relationshipParentRevisionHeader], '2');
    await response(mutate(f, siteAdmin, 'DELETE', board(target), 1, { name }, key), 404);
    await response(mutate(f, manager, 'DELETE', board(target), 1, { name: name.trim() }, key), 404);
    await response(mutate(f, manager, 'DELETE', board(target), 1, { name }), 404);
    await response(f.call(board(target), manager), 404);
    assert.equal((await response(f.call(project(ids.sharedProject), manager), 200)).data.data.boardCount, 0);
    assert.equal((await response(f.call(project(ids.sharedProject), manager), 200)).data.data.boardOrderVersion, 2);

    for (const [collection, id] of deleted) {
      assert.equal(await f.db.collection(collection).countDocuments({ ...f.scope, id }), 0, collection);
      assert.equal(await f.db.collection(collection).countDocuments({ generationId: f.stagedGenerationId, id }), 1, collection);
    }
    for (const [collection, filter] of [
      ['boards', { id: target }], ['lists', { boardId: target }], ['cards', { boardId: target }], ['boardMembers', { boardId: target }],
      ['tasks', { checklistId: deleted.get('checklists') }], ['fieldValues', { cardId: linked }], ['cardLabels', { cardId: linked }],
      ['fieldGroups', { id: group }],
    ]) assert.equal(await f.db.collection(collection).countDocuments({ ...f.scope, ...filter }), 0, collection);
    for (const [collection, id] of [['fieldGroups', projectTemplate], ['fieldDefinitions', templateDefinition],
      ['activities', historicalActivity], ['notifications', historicalNotice]]) {
      assert.ok(await f.db.collection(collection).findOne({ ...f.scope, id }), collection);
    }
    for (const id of [ids.linkedTask, extraTask]) {
      const unavailable = await f.db.collection('tasks').findOne({ ...f.scope, id });
      assert.deepEqual(unavailable.linkedUnavailableProvenance, { id: linked, name: 'Cross-board linked target', completed: true });
      assert.deepEqual([unavailable.linkedCardId, unavailable.linkedUnavailable, unavailable.completed, unavailable.revision], [null, true, null, 2]);
    }
    const stored = await openActiveWorkspace(f.db, f.installationId);
    assert.equal(Object.hasOwn(await stored.read('tasks', ids.linkedTask), 'linkedUnavailableProvenance'), false);
    const leaf = (await response(f.call('/api/v1/cards/' + ids.activeCard, survivingOwner), 200)).data.data;
    assert.equal(leaf.revision, 2);
    const checklists = (await response(f.call('/api/v1/cards/' + ids.activeCard + '/checklists', survivingOwner), 200)).data.data;
    assert.equal(checklists[0].revision, 2);
    assert.equal(checklists[0].tasks.length, 2);
    assert.ok(checklists[0].tasks.every((task) => task.kind === 'unavailable' && !('linkedCard' in task) && !('completed' in task)));
    const audits = await f.db.collection('auditEntries').find({ ...f.scope, action: 'boards.delete', resourceId: target }).toArray();
    assert.equal(audits.length, 1);
    const events = await f.db.collection('events').find({ ...f.scope, commandId: audits[0].commandId }).sort({ boardId: 1 }).toArray();
    assert.deepEqual(events.map(({ boardId, kind, payload }) => [boardId, kind, payload]),
      [[ids.privateBoard, 'board.access-changed', {}], [target, 'board.access-changed', {}]]);
    await f.gate.runCommand(() => f.db.collection('projectManagers').deleteOne({ ...f.scope, id: ids.sharedManager }));
    await response(mutate(f, manager, 'DELETE', board(target), 1, { name }, key), 404);
  });
});
