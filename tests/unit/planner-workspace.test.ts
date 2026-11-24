import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createWorkspaceFixture, workspaceFixtureInstant, workspaceIds } from '../fixtures/planner-workspace.ts';

const ids = workspaceIds;

test('synthetic Planner workspaces have stable identities and independent objects', () => {
  const fixture = createWorkspaceFixture();
  const second = createWorkspaceFixture();
  assert.deepEqual(fixture, second);
  assert.equal(z.uuid().parse(fixture.generationId), ids.generation);
  const recordIds = new Set([fixture.generationId]);
  for (const collection of Object.values(fixture)) {
    if (!Array.isArray(collection)) continue;
    for (const row of collection) {
      assert.equal(z.uuid().parse(row.id), row.id);
      assert.equal(row.generationId, ids.generation);
      assert.equal(new Date(row.createdAt).toISOString(), workspaceFixtureInstant);
      assert.equal(row.updatedAt, workspaceFixtureInstant);
      assert.equal(recordIds.has(row.id), false);
      recordIds.add(row.id);
    }
  }
  fixture.users[0].name = 'Local mutation';
  fixture.boardMembers.pop();
  fixture.fieldValues[0].value = 'Local value';
  assert.deepEqual(second, createWorkspaceFixture());
});

test('fixture roles exercise private ownership, scoped readers and retained disabled membership', () => {
  const fixture = createWorkspaceFixture();
  const user = (id: string) => fixture.users.find((item) => item.id === id);
  const project = (id: string) => fixture.projects.find((item) => item.id === id);
  const member = (userId: string, boardId = ids.privateBoard) => (
    fixture.boardMembers.find((item) => item.userId === userId && item.boardId === boardId)
  );
  assert.ok(fixture.users.every(({ email }) => email.endsWith('@planner.invalid')));
  assert.equal(user(ids.admin)?.role, 'admin');
  assert.equal(member(ids.admin, ids.privateBoard), undefined);
  assert.ok(!fixture.projectManagers.some(({ userId }) => userId === ids.admin));
  const privateProject = project(ids.privateProject);
  const privateManagers = fixture.projectManagers.filter(({ projectId }) => projectId === ids.privateProject);
  assert.equal(privateProject?.type, 'private');
  assert.equal(user(ids.privateOwner)?.role, 'projectOwner');
  assert.deepEqual(privateManagers.map(({ id, userId }) => ({ id, userId })), [
    { id: privateProject?.ownerProjectManagerId, userId: ids.privateOwner },
  ]);
  assert.equal(project(ids.sharedProject)?.type, 'shared');
  assert.equal(project(ids.sharedProject)?.ownerProjectManagerId, null);
  assert.equal(project(ids.hiddenProject)?.hidden, true);

  assert.equal(user(ids.createOnlyOwner)?.role, 'projectOwner');
  assert.ok(!fixture.projectManagers.some(({ userId }) => userId === ids.createOnlyOwner));
  assert.ok(!fixture.boardMembers.some(({ userId }) => userId === ids.createOnlyOwner));
  assert.equal(user(ids.projectManager)?.role, 'projectOwner');
  assert.equal(user(ids.projectManager)?.disabled, false);
  assert.ok(fixture.projectManagers.some(({ projectId, userId }) => projectId === ids.sharedProject && userId === ids.projectManager));
  assert.equal(member(ids.projectManager, ids.sharedBoard), undefined);
  assert.equal(member(ids.firstEditor)?.role, 'editor');
  assert.equal(member(ids.secondEditor)?.role, 'editor');
  assert.equal(user(ids.secondEditor)?.username, null);
  assert.equal(member(ids.viewer)?.role, 'viewer');
  assert.equal(member(ids.viewer)?.canComment, false);
  assert.equal(member(ids.commentingViewer)?.canComment, true);
  assert.ok(!fixture.boardMembers.some(({ userId }) => userId === ids.unrelated));
  assert.equal(user(ids.disabledMember)?.disabled, true);
  assert.ok(member(ids.disabledMember));
});

test('fixture transitions include historical absence, cross-board permission gaps and exact field text', () => {
  const fixture = createWorkspaceFixture();
  for (const board of fixture.boards) {
    const lists = fixture.lists.filter(({ boardId }) => boardId === board.id);
    assert.deepEqual(lists.map(({ kind }) => kind), ['active', 'closed', 'archive', 'trash']);
    assert.deepEqual(lists.map(({ rank }) => rank), ['1024', '2048', null, null]);
  }
  const card = (id: string) => fixture.cards.find((item) => item.id === id);
  const archive = card(ids.archivedStory);
  assert.equal(card(ids.activeCard)?.listId, ids.privateActiveList);
  assert.equal(card(ids.activeCard)?.type, 'project');
  assert.ok(archive);
  assert.equal(archive.type, 'story');
  assert.equal(archive.listId, ids.privateArchive);
  assert.equal(archive.previousListId, ids.removedPriorList);
  assert.ok(!fixture.lists.some(({ id }) => id === archive.previousListId));
  assert.equal(card(ids.trashedCard)?.listId, ids.privateTrash);
  assert.equal(card(ids.trashedCard)?.previousListId, ids.privateClosedList);

  const [assignment] = fixture.cardAssignees;
  assert.equal(assignment.cardId, ids.activeCard);
  assert.ok(fixture.boardMembers.some(({ userId, boardId }) => userId === assignment.userId && boardId === ids.privateBoard));
  assert.ok(!fixture.boardMembers.some(({ userId, boardId }) => userId === assignment.userId && boardId === ids.sharedBoard));
  const [task] = fixture.tasks;
  const sourceCard = fixture.checklists.find(({ id }) => id === task.checklistId)?.cardId;
  assert.ok(sourceCard);
  assert.equal(card(sourceCard)?.boardId, ids.privateBoard);
  assert.equal(card(task.linkedCardId)?.boardId, ids.sharedBoard);
  assert.ok(fixture.boardMembers.some(({ userId, boardId }) => userId === ids.viewer && boardId === ids.privateBoard));
  assert.ok(!fixture.boardMembers.some(({ userId, boardId }) => userId === ids.viewer && boardId === ids.sharedBoard));
  const [field] = fixture.fieldValues;
  assert.equal(field.cardId, ids.activeCard);
  assert.equal(fixture.fieldGroups.find(({ id }) => id === field.groupId)?.boardId, ids.privateBoard);
  assert.equal(fixture.fieldDefinitions.find(({ id }) => id === field.definitionId)?.groupId, field.groupId);
  assert.equal(field.value, '  exact synthetic text  ');
});
