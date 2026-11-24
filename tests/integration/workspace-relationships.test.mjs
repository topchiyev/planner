import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { relationshipBoardInvalidation, relationshipParentRevisionHeader, relationshipReads } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { workspaceFixtureInstant } from '../fixtures/planner-workspace.ts';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const project = (id) => '/api/v1/projects/' + id;
const board = (id) => '/api/v1/boards/' + id;
const card = (id) => '/api/v1/cards/' + id;
const manager = (id, user) => project(id) + '/managers' + (user ? '/' + user : '');
const member = (id, user) => board(id) + '/members' + (user ? '/' + user : '');

async function signIn(f, id) {
  const response = await f.login(id);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const cookie = cookieOf(response);
  assert.ok(cookie);
  return cookie;
}

function mutate(f, cookie, method, path, { revision = 1, ...body }, { key = randomUUID(), headers = {} } = {}) {
  return f.call(path, cookie, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'Idempotency-Key': key,
    'If-Match': '"' + (revision ?? 0) + '"', ...headers,
  } });
}

async function removed(response, parentRevision) {
  const result = await response;
  await expectResponse(result, 204);
  assert.equal(result.data, '');
  assert.equal(result.headers[relationshipParentRevisionHeader], parentRevision === undefined ? undefined : String(parentRevision));
}

async function expectResponse(response, status, code) {
  const result = await response;
  assert.equal(result.status, status, JSON.stringify(result.data));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result.data;
}

async function list(f, cookie, path, operation) {
  const output = await expectResponse(f.call(path, cookie), 200);
  return relationshipReads[operation].output.parse(output);
}

test('project manager changes preserve ownership, authorize every field and recompute each board read path', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const sibling = fixtureId(800);
    const disabledManager = fixtureId(801);
    const privatePath = project(ids.privateProject);
    const candidates = project(ids.sharedProject) + '/manager-candidates';
    try {
      await f.insert('boards', sibling, { projectId: ids.privateProject, name: 'Private sibling', rank: '2048' });
      const owner = await signIn(f, ids.privateOwner);
      const admin = await signIn(f, ids.admin);
      const viewer = await signIn(f, ids.viewer);
      const newcomer = await signIn(f, ids.createOnlyOwner);
      const managerCookie = await signIn(f, ids.projectManager);

      await expectResponse(f.call(manager(ids.privateProject), viewer), 403);
      await expectResponse(f.call(manager(ids.privateProject), admin), 404);
      await expectResponse(mutate(f, owner, 'POST', manager(ids.privateProject), { userId: ids.createOnlyOwner }), 403);
      await expectResponse(mutate(f, admin, 'PATCH', project(ids.hiddenProject), { revision: 1, hidden: false, description: 'Forbidden' }), 403);
      assert.equal((await f.db.collection('projects').findOne({ ...f.scope, id: ids.hiddenProject })).hidden, true);

      const first = await list(f, admin, candidates + '?limit=1', 'projects.managerCandidates');
      assert.deepEqual(first.data.map(({ id }) => id), [ids.admin]);
      assert.ok(first.page.nextCursor);
      const next = await list(f, admin, candidates + '?limit=100&cursor=' + first.page.nextCursor, 'projects.managerCandidates');
      assert.deepEqual(next.data.map(({ id }) => id), [ids.privateOwner, ids.createOnlyOwner]);
      await expectResponse(f.call(candidates + '?limit=1&cursor=' + first.page.nextCursor, managerCookie), 422, 'INVALID_CURSOR');
      await expectResponse(f.call(candidates + '?q=fixture&cursor=' + first.page.nextCursor, admin), 422, 'INVALID_CURSOR');
      await expectResponse(f.call(project(ids.hiddenProject) + '/manager-candidates?cursor=' + first.page.nextCursor, admin), 422);
      await expectResponse(mutate(f, admin, 'POST', manager(ids.sharedProject), { userId: ids.viewer }), 422, 'INELIGIBLE_ACCOUNT');

      await expectResponse(mutate(f, owner, 'PATCH', privatePath, { revision: 1, name: 'x'.repeat(129) }), 422, 'INVALID_REQUEST');
      const releaseKey = randomUUID();
      await expectResponse(mutate(f, owner, 'PATCH', privatePath, { revision: 1, type: 'shared' }, { key: releaseKey }), 200);
      const replay = await expectResponse(mutate(f, owner, 'PATCH', privatePath, { revision: 1, type: 'shared' }, { key: releaseKey }), 200);
      assert.deepEqual(replay.data, { id: ids.privateProject, revision: 2, name: 'Private fixture project', description: null,
        type: 'shared', hidden: false });
      await expectResponse(f.call(board(sibling), admin), 200);
      await expectResponse(f.call(board(sibling), viewer), 404);
      await expectResponse(mutate(f, admin, 'DELETE', manager(ids.privateProject, ids.privateOwner), { revision: 1 }), 409, 'LAST_PROJECT_MANAGER');
      const added = await expectResponse(mutate(f, admin, 'POST', manager(ids.privateProject), { userId: ids.createOnlyOwner, revision: 2 }), 201);
      assert.equal(added.data.parentRevision, 3);
      assert.match(added.data.id, /^[\da-f-]+-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
      await expectResponse(mutate(f, owner, 'POST', manager(ids.privateProject), { userId: ids.createOnlyOwner }), 409, 'RELATIONSHIP_EXISTS');
      await expectResponse(f.call(board(sibling), newcomer), 200);
      await expectResponse(mutate(f, admin, 'PATCH', privatePath, { revision: 2, type: 'private' }), 409, 'REVISION_CONFLICT');
      await expectResponse(mutate(f, admin, 'PATCH', privatePath, { revision: 3, type: 'private' }), 409, 'OWNER_REQUIRES_SOLE_MANAGER');

      await expectResponse(mutate(f, newcomer, 'POST', member(ids.privateBoard), { userId: ids.createOnlyOwner, role: 'viewer' }), 201);
      const removalKey = randomUUID();
      await removed(mutate(f, newcomer, 'DELETE', manager(ids.privateProject, ids.createOnlyOwner), { revision: 1 }, { key: removalKey }), 4);
      await expectResponse(mutate(f, newcomer, 'DELETE', manager(ids.privateProject, ids.createOnlyOwner), { revision: 1 }, { key: removalKey }), 403);
      await expectResponse(f.call(board(sibling), newcomer), 404);
      await expectResponse(f.call(board(ids.privateBoard), newcomer), 200);
      await expectResponse(mutate(f, owner, 'PATCH', privatePath, { revision: 4, type: 'private' }), 403);

      await f.insert('projectManagers', disabledManager, { projectId: ids.privateProject, userId: ids.disabledMember });
      await removed(mutate(f, admin, 'DELETE', manager(ids.privateProject, ids.privateOwner), { revision: 1 }), 5);
      await expectResponse(mutate(f, admin, 'PATCH', privatePath, { revision: 5, type: 'private' }), 409, 'OWNER_REQUIRES_SOLE_MANAGER');
      await expectResponse(mutate(f, admin, 'POST', manager(ids.privateProject), { userId: ids.privateOwner, revision: 5 }), 201);
      await removed(mutate(f, admin, 'DELETE', manager(ids.privateProject, ids.disabledMember), { revision: 1 }), 7);
      const sole = await list(f, admin, manager(ids.privateProject), 'projects.managers');
      assert.equal(sole.data.length, 1);
      const ownerEdge = sole.data[0].id;
      const conversionKey = randomUUID();
      const confirmation = await expectResponse(mutate(f, admin, 'PATCH', privatePath, { revision: 7, type: 'private' }, { key: conversionKey }), 200);
      assert.deepEqual(confirmation.data, { id: ids.privateProject, applied: true });
      await expectResponse(mutate(f, admin, 'PATCH', privatePath, { revision: 7, type: 'private' }, { key: conversionKey }), 404);
      const converted = await f.db.collection('projects').findOne({ ...f.scope, id: ids.privateProject });
      assert.equal(converted.ownerProjectManagerId, ownerEdge);
      assert.equal(converted.revision, 8);
      await expectResponse(f.call(board(sibling), admin), 404);
      await expectResponse(f.call(board(sibling), owner), 200);
      await expectResponse(f.call(card(ids.activeCard), viewer), 200);
      assert.ok(await f.db.collection('projectManagers').findOne({ generationId: f.stagedGenerationId, id: ids.privateOwnerManager }));

      await expectResponse(mutate(f, owner, 'POST', member(ids.hiddenBoard), { userId: ids.admin, role: 'viewer' }), 201);
      const retained = await expectResponse(mutate(f, admin, 'PATCH', project(ids.hiddenProject), { revision: 1, type: 'private' }), 200);
      assert.deepEqual(retained.data, { id: ids.hiddenProject, revision: 2, name: 'Hidden fixture project',
        description: null, hidden: true, type: 'private' });
      await expectResponse(f.call(board(ids.hiddenBoard), admin), 200);

      const changes = await f.db.collection('auditEntries').find({
        ...f.scope, action: 'projects.update', resourceId: ids.privateProject,
      }).toArray();
      assert.equal(changes.length, 2);
      for (const audit of changes) {
        const events = await f.db.collection('events').find({ ...f.scope, commandId: audit.commandId }).toArray();
        assert.deepEqual(new Set(events.map(({ boardId }) => boardId)), new Set([ids.privateBoard, sibling]));
        assert.equal(events.length, 2);
        for (const { boardId, kind, payload } of events) relationshipBoardInvalidation.parse({ boardId, kind, payload });
      }
    } finally { await f.close(); }
  });
});

test('board membership scope respects low-role self-add, exact roster scope and absent legacy revisions', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const endpoint = member(ids.sharedBoard);
    const candidates = board(ids.sharedBoard) + '/member-candidates';
    try {
      await f.insert('projectManagers', fixtureId(810), { projectId: ids.sharedProject, userId: ids.commentingViewer });
      const low = await signIn(f, ids.commentingViewer);
      const managerCookie = await signIn(f, ids.projectManager);
      const editor = await signIn(f, ids.firstEditor);
      const admin = await signIn(f, ids.admin);
      const viewer = await signIn(f, ids.viewer);

      await expectResponse(f.call(endpoint, viewer), 404);
      await expectResponse(f.call(candidates, admin), 403);
      await expectResponse(f.call(candidates, editor), 403);
      await expectResponse(mutate(f, editor, 'PATCH', endpoint + '/' + ids.firstEditor, { revision: 1, role: 'viewer' }), 403);
      await expectResponse(mutate(f, editor, 'DELETE', endpoint + '/' + ids.viewer, { revision: 1 }), 403);
      await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.viewer, role: 'viewer' }), 403);

      const possible = await list(f, low, candidates, 'boards.memberCandidates');
      assert.deepEqual(possible.data.map(({ id }) => id), [ids.commentingViewer]);
      const byName = await list(f, managerCookie, candidates + '?q=second-editor', 'boards.memberCandidates');
      assert.deepEqual(byName.data, [{ id: ids.secondEditor, name: 'Fixture second-editor', username: null }]);
      const all = await list(f, managerCookie, candidates, 'boards.memberCandidates');
      assert.ok(!all.data.some(({ id }) => id === ids.firstEditor || id === ids.disabledMember));
      const first = await list(f, managerCookie, candidates + '?limit=1', 'boards.memberCandidates');
      await expectResponse(f.call(endpoint + '?cursor=' + first.page.nextCursor, managerCookie), 422, 'INVALID_CURSOR');

      for (const headers of [{ Origin: 'https://other.invalid' }, { 'X-CSRF-Token': 'invalid' }]) {
        await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer' }, { headers }), 403);
      }
      await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer' }, { key: 'invalid' }), 422);
      await expectResponse(mutate(f, managerCookie, 'POST', endpoint, { userId: ids.disabledMember, role: 'editor' }), 422, 'INELIGIBLE_ACCOUNT');

      for (const header of ['1', 'W/"1"', '"0"', '"01"', '*', '"1", "2"', '"9007199254740992"']) {
        await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer' },
          { headers: { 'If-Match': header } }), 422, 'INVALID_REQUEST');
      }
      await expectResponse(f.call(endpoint, low, { method: 'POST', body: { userId: ids.commentingViewer, role: 'viewer', revision: 1 },
        headers: { Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(low)), 'Idempotency-Key': randomUUID() } }), 422);
      await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer', expectedRevision: 1 }), 422);
      const key = randomUUID();
      const added = await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer' }, { key }), 201);
      const replay = await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer', canComment: false }, { key }), 201);
      assert.deepEqual(replay, added);
      assert.equal(added.data.parentRevision, 2);
      assert.equal(added.data.canComment, false);
      await expectResponse(mutate(f, low, 'POST', endpoint, { userId: ids.commentingViewer, role: 'viewer', canComment: true }, { key }), 409, 'IDEMPOTENCY_CONFLICT');
      assert.equal((await expectResponse(f.call(board(ids.sharedBoard), low), 200)).data.revision, 2);
      const roster = await list(f, low, endpoint, 'boards.members');
      assert.deepEqual(roster.data.find(({ id }) => id === added.data.id), {
        id: added.data.id, userId: ids.commentingViewer, person: { id: ids.commentingViewer, name: 'Fixture commenting-viewer', username: 'commenting-viewer' },
        role: 'viewer', canComment: false, revision: 1,
      });
      assert.deepEqual((await list(f, low, candidates, 'boards.memberCandidates')).data, []);

      await f.db.collection('boardMembers').updateOne({ ...f.scope, id: fixtureId(106) }, { $unset: { revision: '' } });
      assert.equal((await list(f, managerCookie, endpoint, 'boards.members')).data.find(({ id }) => id === fixtureId(106)).revision, null);
      const edit = await expectResponse(mutate(f, managerCookie, 'PATCH', endpoint + '/' + ids.firstEditor,
        { revision: null, role: 'viewer', canComment: true }), 200);
      assert.deepEqual(edit.data, { id: fixtureId(106), boardId: ids.sharedBoard, userId: ids.firstEditor,
        revision: 1, parentRevision: 3, role: 'viewer', canComment: true });
      await expectResponse(mutate(f, managerCookie, 'PATCH', endpoint + '/' + ids.firstEditor,
        { revision: null, role: 'editor' }), 409, 'REVISION_CONFLICT');
      await expectResponse(mutate(f, managerCookie, 'PATCH', endpoint + '/' + ids.firstEditor,
        { revision: 1, role: 'editor', canComment: false }), 422, 'INVALID_MEMBER_ROLE');
      await expectResponse(mutate(f, managerCookie, 'PATCH', endpoint + '/' + ids.firstEditor,
        { revision: 1, role: 'editor' }), 200);
      const after = await f.db.collection('boardMembers').findOne({ ...f.scope, id: fixtureId(106) });
      assert.equal(after.canComment, null);
      assert.equal(after.revision, 2);

      await removed(mutate(f, low, 'DELETE', endpoint + '/' + ids.commentingViewer, { revision: 1 }), 5);
      const surviving = await expectResponse(f.call(board(ids.sharedBoard), low), 200);
      assert.equal(surviving.data.revision, 5);
      assert.equal(surviving.data.permissions.canManage, true);
      assert.equal(surviving.data.permissions.canFollow, false);
      await expectResponse(mutate(f, managerCookie, 'POST', endpoint, { userId: ids.admin, role: 'viewer', revision: 4 }), 409, 'REVISION_CONFLICT');
      const adminEdge = await expectResponse(mutate(f, managerCookie, 'POST', endpoint, { userId: ids.admin, role: 'viewer', revision: 5 }), 201);
      await removed(mutate(f, admin, 'DELETE', endpoint + '/' + ids.admin, { revision: 1 }), 7);
      assert.ok(adminEdge.data.id);
      const inherited = await expectResponse(f.call(board(ids.sharedBoard), admin), 200);
      assert.equal(inherited.data.permissions.canManage, false);
      assert.equal(inherited.data.permissions.canFollow, false);
      await expectResponse(mutate(f, managerCookie, 'POST', endpoint, { userId: ids.admin, role: 'editor', revision: 7 }), 201);
      const selfRemovalKey = randomUUID();
      await removed(mutate(f, editor, 'DELETE', endpoint + '/' + ids.firstEditor, { revision: 2 }, { key: selfRemovalKey }));
      await expectResponse(mutate(f, editor, 'DELETE', endpoint + '/' + ids.firstEditor, { revision: 2 }, { key: selfRemovalKey }), 404);
      await f.gate.runCommand(() => f.db.collection('users').updateOne({ ...f.scope, id: ids.admin }, { $set: { role: 'boardUser' } }));
      assert.equal((await expectResponse(f.call(board(ids.sharedBoard), admin), 200)).data.permissions.canEdit, true);
      await expectResponse(f.call(board(ids.hiddenBoard), admin), 404);
    } finally { await f.close(); }
  });
});

test('interrupted multi-batch removal replays exact cleanup without returning stale read access', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const archiveChecklist = fixtureId(820);
    const trashChecklist = fixtureId(821);
    const otherChecklist = fixtureId(822);
    const attachment = fixtureId(823);
    const siblingBoard = fixtureId(829);
    const siblingList = fixtureId(836);
    const siblingCard = fixtureId(837);
    const taskOnlyCard = fixtureId(851);
    const taskOnlyChecklist = fixtureId(852);
    const taskOnlyTask = fixtureId(853);
    const targetTask = fixtureId(824);
    const otherUserTask = fixtureId(825);
    const cardLinks = [ids.activeCard, ids.archivedStory, ids.trashedCard];
    const historicalCards = [ids.archivedStory, ids.trashedCard];
    const departing = { ...f.scope, userId: ids.viewer };
    try {
      await f.insert('boards', siblingBoard, { projectId: ids.privateProject, name: 'Same project sibling', rank: '2048' });
      await f.insert('lists', siblingList, { boardId: siblingBoard, kind: 'active', rank: '1024', name: 'Sibling active' });
      await f.insert('cards', siblingCard, { boardId: siblingBoard, listId: siblingList, type: 'project', kind: 'board',
        rank: '1024', name: 'Sibling card' });
      await f.insert('cards', taskOnlyCard, { boardId: ids.privateBoard, listId: ids.privateActiveList, type: 'project', kind: 'board',
        rank: '2048', name: 'Task assignment only' });
      await f.insert('checklists', taskOnlyChecklist, { cardId: taskOnlyCard, name: 'Task assignment only', rank: '1024' });
      await f.insert('tasks', taskOnlyTask, { checklistId: taskOnlyChecklist, name: 'Task assignment only', assigneeId: ids.viewer });
      await f.insert('attachments', attachment, { cardId: ids.activeCard, name: 'Private link', kind: 'link', url: 'https://example.test/fixture' });
      await f.insert('checklists', archiveChecklist, { cardId: historicalCards[0], name: 'Archived work', rank: '1024' });
      await f.insert('checklists', trashChecklist, { cardId: historicalCards[1], name: 'Trashed work', rank: '1024' });
      await f.insert('checklists', otherChecklist, { cardId: ids.sharedTarget, name: 'Outside work', rank: '1024' });
      await f.insert('boardFollows', fixtureId(826), { boardId: ids.privateBoard, userId: ids.viewer });
      await f.insert('boardFollows', fixtureId(827), { boardId: ids.sharedBoard, userId: ids.viewer });
      await f.insert('boardFollows', fixtureId(828), { boardId: ids.privateBoard, userId: ids.firstEditor });
      await f.insert('boardFollows', fixtureId(832), { boardId: siblingBoard, userId: ids.viewer });
      await f.insert('boardFollows', fixtureId(826), { boardId: ids.privateBoard, userId: ids.viewer }, f.stagedGenerationId);
      const idempotencyKey = randomUUID();
      for (const [i, cardId] of [...cardLinks, ids.sharedTarget, siblingCard].entries()) {
        await f.insert('cardFollows', fixtureId(830 + i), { cardId, userId: ids.viewer });
        await f.insert('cardAssignees', fixtureId(840 + i), { cardId, userId: ids.viewer });
      }
      await f.insert('cardFollows', fixtureId(835), { cardId: ids.activeCard, userId: ids.firstEditor });
      await f.insert('cardAssignees', fixtureId(840), { cardId: ids.activeCard, userId: ids.viewer }, f.stagedGenerationId);
      await f.insert('tasks', targetTask, { checklistId: otherChecklist, linkedCardId: ids.activeCard,
        assigneeId: ids.viewer, completed: true, rank: '1024' });
      await f.insert('tasks', otherUserTask, { checklistId: archiveChecklist, assigneeId: ids.firstEditor, name: 'Keep assignee', rank: '3072' });
      const time = new Date(workspaceFixtureInstant);
      const manyTasks = Array.from({ length: 270 }, (_, index) => {
        const id = fixtureId(2000 + index);
        return { id, _id: workspaceKey(f.generationId, id), ...f.scope, revision: 1, createdAt: time,
          checklistId: [ids.checklist, archiveChecklist, trashChecklist][index % 3], assigneeId: ids.viewer,
          completed: index % 2 === 0, name: 'Retain task ' + index };
      });
      await f.db.collection('tasks').insertMany(manyTasks);
      await f.db.collection('tasks').updateOne({ ...f.scope, id: ids.linkedTask }, { $set: { assigneeId: ids.viewer } });
      await f.db.collection('tasks').updateOne({ generationId: f.stagedGenerationId, id: ids.linkedTask }, { $set: { assigneeId: ids.viewer } });
      const viewer = await signIn(f, ids.viewer);
      const owner = await signIn(f, ids.privateOwner);
      await expectResponse(f.call(card(ids.activeCard), viewer), 200);
      const token = readSessionCookie(viewer);
      const commandInput = { id: ids.privateBoard, userId: ids.viewer, expectedRevision: 1 };
      const interruption = new Error('test interruption after first durable batch');
      const journal = new CommandJournal(f.gate, f.db, f.installationId, {
        operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now())),
        checkpoint(point, index) {
          if (point === 'effectApplied' && index === 256) throw interruption;
        },
      });
      await assert.rejects(journal.execute({ actorId: ids.viewer, operationId: 'boards.removeMember', idempotencyKey, input: commandInput }),
        (error) => error === interruption);
      assert.equal(f.gate.ready, false);
      await expectResponse(f.call(card(ids.activeCard), owner), 503);
      const command = await f.db.collection('commands').findOne({ ...f.scope, actorId: ids.viewer, idempotencyKey });
      assert.equal(command.status, 'prepared');
      assert.ok(await f.db.collection('commandEffectBatches').countDocuments({ ...f.scope, commandId: command.id }) >= 2);
      const remaining = await f.db.collection('tasks').countDocuments({ ...f.scope, id: { $in: manyTasks.map(({ id }) => id) }, assigneeId: ids.viewer });
      assert.ok(remaining > 0 && remaining < manyTasks.length);
      await new CommandJournal(f.gate, f.db, f.installationId).recover();
      assert.equal(f.gate.ready, true);

      const retry = await expectResponse(mutate(f, viewer, 'DELETE', member(ids.privateBoard, ids.viewer), { revision: 1 }, { key: idempotencyKey }), 404);
      assert.equal(Object.keys(retry).includes('data'), false);
      await expectResponse(f.call(board(ids.privateBoard), viewer), 404);
      await expectResponse(f.call(card(ids.activeCard), viewer), 404);
      await expectResponse(f.call(card(ids.activeCard) + '/checklists', viewer), 404);
      await assert.rejects(f.gate.readSnapshot(async () =>
        (await resolveBrowserWorkspace(f.db, f.installationId, token, f.now())).requireAttachment(attachment)),
      (error) => error.statusCode === 404);
      const own = await expectResponse(f.call(card(ids.activeCard), owner), 200);
      assert.equal(own.data.revision, 2);
      assert.equal((await expectResponse(f.call(board(ids.privateBoard), owner), 200)).data.revision, 2);
      const cards = await f.db.collection('cards').find({ ...f.scope,
        id: { $in: [...cardLinks, ids.sharedTarget, siblingCard, taskOnlyCard] } }).toArray();
      assert.equal(cards.length, 6);
      for (const { id, revision } of cards) assert.equal(revision, [...cardLinks, taskOnlyCard].includes(id) ? 2 : 1);
      const checklists = await f.db.collection('checklists').find({ ...f.scope,
        id: { $in: [ids.checklist, archiveChecklist, trashChecklist, otherChecklist, taskOnlyChecklist] } }).toArray();
      assert.equal(checklists.length, 5);
      for (const { id, revision } of checklists) assert.equal(revision, id === otherChecklist ? 1 : 2);
      assert.equal((await f.db.collection('tasks').findOne({ ...f.scope, id: taskOnlyTask })).assigneeId, null);

      assert.equal(await f.db.collection('boardFollows').countDocuments({ ...departing, boardId: ids.privateBoard }), 0);
      assert.equal(await f.db.collection('boardFollows').countDocuments({ ...departing, boardId: ids.sharedBoard }), 1);
      assert.equal(await f.db.collection('boardFollows').countDocuments({ ...departing, boardId: siblingBoard }), 1);
      assert.equal(await f.db.collection('boardFollows').countDocuments({ ...f.scope, userId: ids.firstEditor }), 1);
      for (const collection of ['cardFollows', 'cardAssignees']) {
        assert.equal(await f.db.collection(collection).countDocuments({ ...departing, cardId: { $in: cardLinks } }), 0);
        assert.equal(await f.db.collection(collection).countDocuments({ ...departing, cardId: ids.sharedTarget }), 1);
        assert.equal(await f.db.collection(collection).countDocuments({ ...departing, cardId: siblingCard }), 1);
      }
      const persisted = await f.db.collection('tasks').find({ ...f.scope, id: { $in: manyTasks.map(({ id }) => id) } }).sort({ id: 1 }).toArray();
      assert.equal(persisted.length, manyTasks.length);
      for (const [index, row] of persisted.entries()) {
        assert.equal(row.assigneeId, null);
        assert.equal(row.revision, 2);
        for (const field of ['name', 'checklistId', 'completed']) assert.equal(row[field], manyTasks[index][field]);
      }
      const [linked, outside, otherUser] = await Promise.all([ids.linkedTask, targetTask, otherUserTask].map((id) =>
        f.db.collection('tasks').findOne({ ...f.scope, id })));
      assert.equal(linked.assigneeId, null);
      assert.equal(linked.linkedCardId, ids.sharedTarget);
      assert.equal(outside.assigneeId, ids.viewer);
      assert.equal(outside.linkedCardId, ids.activeCard);
      assert.equal(otherUser.assigneeId, ids.firstEditor);
      for (const [name, id] of [['tasks', ids.linkedTask], ['boardFollows', fixtureId(826)], ['cardAssignees', fixtureId(840)]]) {
        const staged = await f.db.collection(name).findOne({ generationId: f.stagedGenerationId, id });
        assert.equal(staged.assigneeId ?? staged.userId, ids.viewer);
      }
      const audits = await f.db.collection('auditEntries').find({ ...f.scope, commandId: command.id }).toArray();
      assert.equal(audits.length, 1);
      const events = await f.db.collection('events').find({ ...f.scope, commandId: command.id }).toArray();
      assert.deepEqual(events.map(({ boardId, kind, payload }) => ({ boardId, kind, payload })),
        [{ boardId: ids.privateBoard, kind: 'board.access-changed', payload: {} }]);
    } finally { await f.close(); }
  });
});

test('relationship commands recheck the session epoch and active generation before any intent', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    let invalidate;
    const f = await makeWorkspaceAccessFixture(mongo, {
      async beforeAdmission({ session, gate }) {
        if (!invalidate || session?.account.id !== ids.projectManager) return;
        const change = invalidate;
        invalidate = undefined;
        await gate.runCommand(change);
      },
    });
    try {
      const endpoint = member(ids.sharedBoard);
      const input = { userId: ids.secondEditor, role: 'editor' };
      const first = await signIn(f, ids.projectManager);
      invalidate = () => f.db.collection('users').updateOne({ ...f.scope, id: ids.projectManager },
        { $inc: { 'localAuth.credentialsVersion': 1 } });
      await expectResponse(mutate(f, first, 'POST', endpoint, input), 401, 'UNAUTHENTICATED');

      const second = await signIn(f, ids.projectManager);
      invalidate = () => f.db.collection('installation').updateOne({ _id: 'installation', installationId: f.installationId },
        { $set: { activeGenerationId: f.stagedGenerationId } });
      await expectResponse(mutate(f, second, 'POST', endpoint, input), 401, 'UNAUTHENTICATED');
      assert.equal(await f.db.collection('commands').countDocuments({ operationId: 'boards.addMember' }), 0);
      assert.equal(await f.db.collection('boardMembers').countDocuments({ boardId: ids.sharedBoard, userId: ids.secondEditor }), 0);
    } finally { await f.close(); }
  });
});
