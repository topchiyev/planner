import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceOperations } from '@planner/contracts';
import { readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { requireCapability, resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture } from '../support/workspace-access-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);
const projects = '/api/v1/projects';
const boardPath = (id) => '/api/v1/boards/' + id;
const cardPath = (id) => '/api/v1/cards/' + id;
const resultIds = (result) => result.data.data.map(({ id }) => id);

async function actor(fixture, id) {
  const response = await fixture.login(id);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const cookie = cookieOf(response);
  assert.ok(cookie);
  return cookie;
}

async function verified(fixture, path, cookie, operation) {
  const response = await fixture.call(path, cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(workspaceOperations[operation].output.safeParse(response.data).success, true);
  return response;
}

test('protected workspace endpoints enforce ownership, hidden context, independent capabilities and visible siblings', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const sibling = fixtureId(700);
    const sharedTrashCard = fixtureId(705);
    try {
      await f.insert('cards', sharedTrashCard, { boardId: ids.sharedBoard, listId: ids.sharedTrash,
        type: 'project', kind: 'trash', rank: null, name: 'Shared historical card' });
      await f.insert('boards', sibling, { projectId: ids.privateProject, name: 'Private sibling secret', rank: '2048' });
      await f.insert('projectFavorites', fixtureId(703), { projectId: ids.hiddenProject, userId: ids.admin });
      const invalidOwner = fixtureId(706);
      await f.insert('projects', invalidOwner, { name: 'Invalid owner must stay private to outsiders', type: 'shared', hidden: false,
        ownerProjectManagerId: [null, ids.privateOwnerManager], rank: '0' });
      await f.insert('boardMembers', fixtureId(707), { boardId: ids.privateBoard, userId: ids.admin, role: ['viewer'], canComment: true });
      const admin = await actor(f, ids.admin);
      const owner = await actor(f, ids.privateOwner);
      const manager = await actor(f, ids.projectManager);
      const createOnly = await actor(f, ids.createOnlyOwner);
      const editor = await actor(f, ids.firstEditor);
      const viewer = await actor(f, ids.viewer);
      const commenter = await actor(f, ids.commentingViewer);
      const unrelated = await actor(f, ids.unrelated);
      assert.equal((await f.login(ids.disabledMember)).status, 401);
      assert.equal((await f.call(projects)).status, 401);
      assert.equal((await f.call(projects, admin, { headers: { 'X-Forwarded-Host': 'foreign.invalid' } })).status, 401);

      assert.equal((await f.call(projects + '/' + ids.privateProject, admin)).status, 404);
      assert.equal((await f.call(projects + '/' + invalidOwner, admin)).status, 404);
      assert.equal((await f.call(boardPath(ids.privateBoard), admin)).status, 404);
      assert.equal((await f.call(cardPath(ids.activeCard), admin)).status, 404);
      const missing = await f.call(boardPath(fixtureId(999)), admin);
      const denied = await f.call(boardPath(ids.privateBoard), admin);
      assert.equal(denied.data.error.code, missing.data.error.code);
      assert.equal(denied.data.error.message, missing.data.error.message);

      assert.deepEqual(resultIds(await verified(f, projects, admin, 'projectsList')), [ids.sharedProject]);
      assert.deepEqual(resultIds(await verified(f, projects + '?hidden=include', admin, 'projectsList')), [ids.sharedProject, ids.hiddenProject]);
      assert.deepEqual(resultIds(await verified(f, projects + '?hidden=only&favorite=true', admin, 'projectsList')), [ids.hiddenProject]);
      assert.deepEqual(resultIds(await verified(f, projects + '?hidden=include&q=Private', admin, 'projectsList')), []);
      const shared = (await verified(f, projects + '/' + ids.sharedProject, admin, 'projectGet')).data.data;
      assert.equal(shared.permissions.canToggleHidden, true);
      assert.equal(shared.permissions.canEdit, false);
      assert.equal(shared.permissions.canChangeOwnership, true);
      assert.equal(shared.managers, null);
      const hidden = (await verified(f, boardPath(ids.hiddenBoard), admin, 'boardGet')).data.data;
      assert.deepEqual(hidden.permissions, {
        canManage: false, canEdit: false, canComment: false, canFollow: false, canDuplicateFrom: false, canClearTrash: false,
      });

      const received = (await verified(f, projects + '/' + ids.privateProject, viewer, 'projectGet')).data.data;
      assert.deepEqual(received.boards.map(({ id }) => id), [ids.privateBoard]);
      assert.equal(received.boardCount, 1);
      assert.equal(received.managers, null);
      assert.equal(received.backgrounds, null);
      assert.equal(received.fieldTemplates, null);
      assert.equal(JSON.stringify(received).includes(sibling), false);
      assert.equal((await f.call(boardPath(sibling), viewer)).status, 404);
      assert.deepEqual(resultIds(await verified(f, projects + '/' + ids.privateProject + '/boards', viewer, 'boardsList')), [ids.privateBoard]);
      const own = (await verified(f, projects + '/' + ids.privateProject, owner, 'projectGet')).data.data;
      assert.deepEqual(own.boards.map(({ id }) => id), [ids.privateBoard, sibling]);
      assert.equal(own.boardCount, 2);
      assert.equal(own.managers[0].id, ids.privateOwner);
      assert.equal(own.permissions.canChangeOwnership, true);
      assert.equal(own.permissions.canDelete, false);

      const managed = (await verified(f, boardPath(ids.sharedBoard), manager, 'boardGet')).data.data;
      assert.equal(managed.permissions.canManage, true);
      assert.equal(managed.permissions.canEdit, false);
      assert.equal(managed.permissions.canComment, false);
      assert.equal(managed.permissions.canDuplicateFrom, true);
      assert.equal(managed.permissions.canClearTrash, true);
      const managerTrash = (await verified(f, cardPath(sharedTrashCard), manager, 'cardGet')).data.data.permissions;
      const editorTrash = (await verified(f, cardPath(sharedTrashCard), editor, 'cardGet')).data.data.permissions;
      assert.deepEqual([managerTrash.canMove, managerTrash.canRestore, managerTrash.canPurge], [false, false, false]);
      assert.deepEqual([editorTrash.canMove, editorTrash.canRestore, editorTrash.canPurge], [true, true, true]);
      const ownerList = (await verified(f, projects, createOnly, 'projectsList')).data;
      assert.equal(ownerList.permissions.canCreate, true);
      assert.deepEqual(ownerList.data, []);
      assert.equal((await f.call(boardPath(ids.sharedBoard), createOnly)).status, 404);
      assert.equal((await f.call(boardPath(ids.sharedBoard), unrelated)).status, 404);
      assert.equal((await verified(f, projects, unrelated, 'projectsList')).data.permissions.canCreate, false);

      for (const [token, expected] of [[viewer, [false, false]], [commenter, [false, true]], [editor, [true, true]]]) {
        const board = (await verified(f, boardPath(ids.privateBoard), token, 'boardGet')).data.data;
        assert.deepEqual([board.permissions.canEdit, board.permissions.canComment], expected);
        assert.equal(board.permissions.canFollow, true);
      }
      const history = (await verified(f, cardPath(ids.archivedStory), editor, 'cardGet')).data.data;
      assert.equal(history.permissions.canEdit, false);
      assert.equal(history.permissions.canMove, true);
      assert.equal(history.permissions.canRestore, true);
      assert.equal(history.previousListId, null);
      assert.equal(JSON.stringify(history).includes(ids.removedPriorList), false);

      const longName = fixtureId(704);
      const name = 'An imported project ' + 'x'.repeat(2500);
      await f.insert('projects', longName, { type: 'shared', hidden: false, ownerProjectManagerId: null, name, rank: '4096' });
      const alpha = projects + '?hidden=include&order=alphabetically&limit=1';
      const firstAlpha = (await verified(f, alpha, admin, 'projectsList')).data;
      assert.equal(firstAlpha.data[0].name, name);
      assert.ok(firstAlpha.page.nextCursor.length < 2048);
      const nextAlpha = await verified(f, alpha + '&cursor=' + encodeURIComponent(firstAlpha.page.nextCursor), admin, 'projectsList');
      assert.deepEqual(resultIds(nextAlpha), [ids.hiddenProject]);
      await f.gate.runCommand(() => mongo.db.collection('projects').updateOne({ ...f.scope, id: longName },
        { $set: { name: 'Zulu moved beyond the second page' }, $inc: { revision: 1 } }));
      const renamed = await f.call(alpha + '&cursor=' + encodeURIComponent(firstAlpha.page.nextCursor), admin);
      assert.equal(renamed.status, 422);
      assert.equal(renamed.data.error.code, 'INVALID_CURSOR');
      assert.deepEqual(resultIds(await verified(f, alpha, admin, 'projectsList')), [ids.hiddenProject]);
      const binaryNames = ['Zulu', 'alpha', 'Étage'];
      for (let index = 0; index < binaryNames.length; index += 1) {
        await f.insert('projects', fixtureId(710 + index), { name: binaryNames[index], description: 'ordering-sample',
          type: 'shared', hidden: false, ownerProjectManagerId: null, rank: '8192' });
      }
      const mixed = await verified(f, projects + '?order=alphabetically&q=ordering-sample', admin, 'projectsList');
      assert.deepEqual(mixed.data.data.map(({ name }) => name), binaryNames);

      await assert.rejects(f.gate.runCommand(async () => {
        const context = await resolveBrowserWorkspace(f.db, f.installationId, readSessionCookie(manager), f.now());
        requireCapability((await context.requireBoard(ids.sharedBoard)).permissions.canEdit);
      }), { statusCode: 403, code: 'FORBIDDEN' });
      assert.equal(f.gate.ready, true);
    } finally { await f.close(); }
  });
});

test('workspace aggregation and child projections stay in the authorized parent and generation', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const related = fixtureId(710);
    const foreign = fixtureId(711);
    const listDrift = fixtureId(712);
    const newerHistory = fixtureId(713);
    const extra = fixtureId(714);
    const comment = fixtureId(720);
    const unexpectedComment = fixtureId(721);
    const inaccessibleFile = fixtureId(730);
    const safeLink = fixtureId(731);
    const foreignTemplate = fixtureId(740);
    const foreignDefinition = fixtureId(741);
    const originalTemplate = fixtureId(745);
    const templateDefinition = fixtureId(746);
    const instance = fixtureId(747);
    const digest = '2'.repeat(64);
    try {
      await f.insert('labels', related, { boardId: ids.privateBoard, name: 'Owned label', rank: '1024' });
      await f.insert('labels', foreign, { boardId: ids.sharedBoard, name: 'Foreign secret label', rank: '1024' });
      const dueDate = '2026-04-01T04:05:06.723Z';
      await f.insert('cards', extra, { name: 'Second matching label', description: 'Needle with [literal] punctuation and Artifact/', dueDate,
        boardId: ids.privateBoard, listId: ids.privateActiveList, type: 'project', kind: 'board', rank: '1024' });
      await f.insert('cards', listDrift, { name: 'Wrong board private sentinel', boardId: ids.privateBoard,
        listId: ids.sharedActiveList, type: 'project', kind: 'board', rank: '0' });
      await f.insert('cards', newerHistory, { name: 'Earlier rank later sequence', boardId: ids.privateBoard, listId: ids.privateArchive,
        type: 'story', kind: 'archive', rank: null, listChangedAt: '2026-01-15T10:30:45.000Z', historySequence: '9007199254740994' });
      await f.insert('cardLabels', fixtureId(716), { cardId: extra, labelId: related });
      await f.insert('cardLabels', fixtureId(717), { cardId: ids.activeCard, labelId: foreign });
      await f.insert('cardLabels', fixtureId(718), { cardId: ids.activeCard, labelId: related }, f.stagedGenerationId);
      await f.insert('comments', comment, { boardId: ids.privateBoard, cardId: ids.activeCard, authorId: ids.commentingViewer, text: 'Visible comment' });
      await f.insert('comments', unexpectedComment, { boardId: ids.sharedBoard, cardId: ids.activeCard, text: 'Cross-board secret comment' });
      await f.insert('attachments', inaccessibleFile, { cardId: ids.activeCard, kind: 'file', name: 'Unbound file', blobDigest: digest, byteLength: 4 });
      await f.insert('attachments', safeLink, { cardId: ids.activeCard, kind: 'link', name: 'Reading', url: 'https://example.test/guide' });
      await f.insert('blobs', fixtureId(733), { digest, byteLength: 4, lifecycleState: 'available' }, f.stagedGenerationId);
      await f.insert('fieldGroups', foreignTemplate, { scopeType: 'project', scopeId: ids.sharedProject, name: 'Foreign template', rank: '1024' });
      await f.insert('fieldDefinitions', foreignDefinition, { fieldGroupId: foreignTemplate, name: 'Foreign definition', rank: '1024' });
      await f.insert('fieldValues', fixtureId(744), { cardId: ids.activeCard, fieldGroupId: ids.fieldGroup,
        fieldDefinitionId: foreignDefinition, value: 'Restricted field text' });

      await f.insert('fieldGroups', originalTemplate, { scopeType: 'project', scopeId: ids.privateProject, name: 'Private template', rank: '1024' });
      await f.insert('fieldDefinitions', templateDefinition, { fieldGroupId: originalTemplate, name: 'Visible definition', rank: '1024' });
      await f.insert('fieldGroups', instance, { scopeType: 'board', scopeId: ids.privateBoard, templateGroupId: originalTemplate,
        name: 'Field instance', rank: '2048' });
      await f.insert('fieldValues', fixtureId(748), { cardId: ids.activeCard, fieldGroupId: instance,
        fieldDefinitionId: templateDefinition, value: 'Visible template value' });

      const viewer = await actor(f, ids.viewer);
      const editor = await actor(f, ids.firstEditor);
      const commenter = await actor(f, ids.commentingViewer);
      const owner = await actor(f, ids.privateOwner);
      const path = boardPath(ids.privateBoard) + '/cards';
      const first = await verified(f, path + '?limit=1', viewer, 'boardCards');
      assert.deepEqual(resultIds(first), [ids.activeCard]);
      const cursor = first.data.page.nextCursor;
      assert.ok(cursor);
      const next = path + '?limit=1&cursor=' + encodeURIComponent(cursor);
      const secondPage = await verified(f, next, viewer, 'boardCards');
      assert.deepEqual(resultIds(secondPage), [extra]);
      assert.equal(secondPage.data.data[0].dueDate, dueDate);
      assert.equal((await verified(f, cardPath(extra), viewer, 'cardGet')).data.data.dueDate, dueDate);
      assert.ok((await mongo.db.collection('cards').findOne({ ...f.scope, id: extra })).dueDate instanceof Date);
      await mongo.db.collection('cards').updateOne({ ...f.scope, id: extra }, { $set: { dueDate } });
      assert.equal((await verified(f, next, viewer, 'boardCards')).data.data[0].dueDate, dueDate);
      assert.equal((await verified(f, cardPath(extra), viewer, 'cardGet')).data.data.dueDate, dueDate);
      assert.equal((await f.call(next, editor)).status, 422);
      assert.equal((await f.call(next + '&q=needle', viewer)).status, 422);
      assert.equal((await f.call(boardPath(ids.privateBoard) + '/cards?unknown=true', viewer)).status, 422);
      assert.equal((await f.call(path + '?id=' + ids.sharedBoard, viewer)).status, 422);
      assert.deepEqual(resultIds(await verified(f, path + '?limit=1&labelsAny=' + related, viewer, 'boardCards')), [extra]);
      assert.deepEqual(resultIds(await verified(f, path + '?labelsAny=' + foreign, viewer, 'boardCards')), []);
      assert.deepEqual(resultIds(await verified(f, path + '?labelsNone=' + related, viewer, 'boardCards')), [ids.activeCard]);
      assert.deepEqual(resultIds(await verified(f, path + '?members=' + ids.secondEditor, viewer, 'boardCards')), [ids.activeCard]);
      assert.deepEqual(resultIds(await verified(f, path + '?unassigned=true', viewer, 'boardCards')), [extra]);
      for (const q of ['Needle; [literal]', '/needl[e]/', 'Artifact/']) {
        const search = await verified(f, path + '?q=' + encodeURIComponent(q), viewer, 'boardCards');
        assert.equal(search.data.searchValidation, 'ok', JSON.stringify(search.data));
        assert.deepEqual(resultIds(search), [extra]);
      }
      assert.equal((await verified(f, path + '?q=' + encodeURIComponent('/(invalid/'), viewer, 'boardCards')).data.searchValidation, 'invalid-pattern');
      assert.deepEqual(resultIds(await verified(f, path + '?q=sentinel', viewer, 'boardCards')), []);
      const archive = await verified(f, path + '?context=archive&limit=1', viewer, 'boardCards');
      assert.deepEqual(resultIds(archive), [newerHistory]);
      assert.deepEqual(resultIds(await verified(f, path + '?context=archive&limit=1&cursor=' +
        encodeURIComponent(archive.data.page.nextCursor), viewer, 'boardCards')), [ids.archivedStory]);

      const workspace = (await verified(f, boardPath(ids.privateBoard) + '/workspace', viewer, 'boardWorkspace')).data.data;
      assert.equal(workspace.lists.find(({ id }) => id === ids.privateActiveList).cardCount, 2);
      assert.equal(workspace.lists.find(({ id }) => id === ids.privateArchive).cardCount, 2);
      const card = (await verified(f, cardPath(ids.activeCard), viewer, 'cardGet')).data.data;
      assert.deepEqual(card.labels, []);
      assert.equal(card.assignees[0].id, ids.secondEditor);
      assert.deepEqual(card.values, [
        { fieldGroupId: ids.fieldGroup, fieldDefinitionId: ids.fieldDefinition, value: '  exact synthetic text  ' },
        { fieldGroupId: instance, fieldDefinitionId: templateDefinition, value: 'Visible template value' },
      ]);
      assert.equal(card.fields.find(({ id }) => id === instance).definitions[0].fieldGroupId, instance);
      assert.equal(JSON.stringify(card).includes(originalTemplate), false);
      assert.equal(card.attachments.find(({ id }) => id === inaccessibleFile).available, false);
      assert.equal(card.attachments.find(({ id }) => id === safeLink).url, 'https://example.test/guide');
      for (const value of ['Staged restricted identity', 'Foreign template', 'Foreign secret label', 'Restricted field text', digest]) {
        assert.equal(JSON.stringify(card).includes(value), false);
      }
      assert.equal((await f.call(cardPath(listDrift), viewer)).status, 404);

      const hiddenTarget = (await verified(f, cardPath(ids.activeCard) + '/checklists', viewer, 'cardChecklists')).data.data[0].tasks[0];
      assert.deepEqual(Object.keys(hiddenTarget).sort(), ['checklistId', 'createdAt', 'id', 'kind', 'rank', 'revision', 'updatedAt']);
      assert.equal(hiddenTarget.kind, 'unavailable');
      assert.equal(JSON.stringify(hiddenTarget).includes(ids.sharedTarget), false);
      const linked = (await verified(f, cardPath(ids.activeCard) + '/checklists', editor, 'cardChecklists')).data.data[0].tasks[0];
      assert.equal(linked.linkedCard.id, ids.sharedTarget);
      assert.equal(linked.linkedCard.completed, true);

      const feed = cardPath(ids.activeCard) + '/comments';
      assert.deepEqual(resultIds(await verified(f, feed, viewer, 'cardComments')), [comment]);
      assert.deepEqual((await verified(f, feed, commenter, 'cardComments')).data.data[0].permissions, { canEdit: true, canDelete: true });
      assert.deepEqual((await verified(f, feed, owner, 'cardComments')).data.data[0].permissions, { canEdit: false, canDelete: true });
      await f.gate.readSnapshot(async () => {
        const scope = await resolveBrowserWorkspace(f.db, f.installationId, readSessionCookie(viewer), f.now());
        await assert.rejects(scope.requireLabel(foreign, ids.privateBoard), { statusCode: 404 });
        await assert.rejects(scope.requireComment(unexpectedComment), { statusCode: 404 });
        await assert.rejects(scope.requireCardField(ids.activeCard, ids.fieldGroup, foreignDefinition), { statusCode: 404 });
        assert.equal((await scope.requireCardField(ids.activeCard, instance, templateDefinition)).definition.id, templateDefinition);
        await assert.rejects(scope.requireFieldGroup(originalTemplate), { statusCode: 404 });
        assert.equal((await scope.requireAttachment(inaccessibleFile)).card.card.id, ids.activeCard);
        assert.equal((await scope.requireTask(ids.linkedTask)).card.card.id, ids.activeCard);
      });
    } finally { await f.close(); }
  });
});

test('workspace rechecks cookie epoch and active generation within its own snapshot', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    let invalidate = false;
    const f = await makeWorkspaceAccessFixture(mongo, {
      async beforeAdmission({ session, db, gate, generationId }) {
        if (!invalidate || session?.account.id !== ids.viewer) return;
        invalidate = false;
        await gate.runCommand(() => db.collection('users').updateOne({ generationId, id: ids.viewer }, { $inc: { 'localAuth.credentialsVersion': 1 } }));
      },
    });
    try {
      const viewer = await actor(f, ids.viewer);
      const path = boardPath(ids.privateBoard) + '/cards';
      assert.deepEqual(resultIds(await verified(f, path, viewer, 'boardCards')), [ids.activeCard]);
      invalidate = true;
      assert.equal((await f.call(path, viewer)).status, 401);
      const admin = await actor(f, ids.admin);
      const first = await verified(f, projects + '?hidden=include&limit=1', admin, 'projectsList');
      assert.ok(first.data.page.nextCursor);
      await f.gate.runCommand(() => mongo.db.collection('installation').updateOne({ _id: 'installation', installationId: f.installationId },
        { $set: { activeGenerationId: f.stagedGenerationId } }));
      assert.equal((await f.call(projects, admin)).status, 401);
      const staged = await actor(f, ids.admin);
      assert.equal((await f.call(projects + '?hidden=include&limit=1&cursor=' + encodeURIComponent(first.data.page.nextCursor), staged)).status, 422);
      const card = (await verified(f, cardPath(ids.activeCard), staged, 'cardGet')).data.data;
      assert.equal(card.name, 'Staged restricted identity');
      assert.equal(card.permissions.canEdit, true);
    } finally { await f.close(); }
  });
});
