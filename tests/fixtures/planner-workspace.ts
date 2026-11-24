function fixtureId(sequence: number) {
  return `65160d3b-4e42-4023-880e-${sequence.toString(16).padStart(12, '0')}`;
}

export const workspaceIds = Object.freeze({
  generation: fixtureId(1),
  admin: fixtureId(10),
  privateOwner: fixtureId(11),
  createOnlyOwner: fixtureId(12),
  projectManager: fixtureId(13),
  firstEditor: fixtureId(14),
  secondEditor: fixtureId(15),
  viewer: fixtureId(16),
  commentingViewer: fixtureId(17),
  unrelated: fixtureId(18),
  disabledMember: fixtureId(19),
  privateProject: fixtureId(30),
  sharedProject: fixtureId(31),
  hiddenProject: fixtureId(32),
  privateOwnerManager: fixtureId(40),
  privateManager: fixtureId(41),
  sharedManager: fixtureId(42),
  hiddenManager: fixtureId(43),
  privateBoard: fixtureId(50),
  sharedBoard: fixtureId(51),
  hiddenBoard: fixtureId(52),
  privateActiveList: fixtureId(60),
  privateClosedList: fixtureId(61),
  privateArchive: fixtureId(62),
  privateTrash: fixtureId(63),
  sharedActiveList: fixtureId(64),
  sharedClosedList: fixtureId(65),
  sharedArchive: fixtureId(66),
  sharedTrash: fixtureId(67),
  hiddenActiveList: fixtureId(68),
  hiddenClosedList: fixtureId(69),
  hiddenArchive: fixtureId(70),
  hiddenTrash: fixtureId(71),
  removedPriorList: fixtureId(72),
  activeCard: fixtureId(80),
  archivedStory: fixtureId(81),
  trashedCard: fixtureId(82),
  sharedTarget: fixtureId(83),
  checklist: fixtureId(90),
  linkedTask: fixtureId(91),
  fieldGroup: fixtureId(92),
  fieldDefinition: fixtureId(93),
  fieldValue: fixtureId(94),
});

export const workspaceFixtureInstant = '2026-01-15T10:30:45.000Z';

type SiteRole = 'admin' | 'projectOwner' | 'boardUser';
type BoardRole = 'editor' | 'viewer';

// Each call returns new records, including relationships, for the same synthetic workspace.
export function createWorkspaceFixture() {
  const ids = workspaceIds;
  const data = (id: string) => ({
    id,
    generationId: ids.generation,
    revision: 1,
    createdAt: workspaceFixtureInstant,
    updatedAt: workspaceFixtureInstant,
  });
  function user(id: string, key: string, role: SiteRole, options: { username?: string | null; disabled?: boolean } = {}) {
    return {
      ...data(id), name: `Fixture ${key}`, email: `${key}@planner.invalid`, role,
      username: options.username === null ? null : (options.username ?? key),
      disabled: options.disabled ?? false,
    };
  }
  function membership(id: number, boardId: string, userId: string, role: BoardRole, canComment: boolean | null) {
    return { ...data(fixtureId(id)), boardId, userId, role, canComment };
  }
  function listsFor(boardId: string, [active, closed, archive, trash]: readonly [string, string, string, string]) {
    return [
      { ...data(active), boardId, kind: 'active', rank: '1024', name: 'To do' },
      { ...data(closed), boardId, kind: 'closed', rank: '2048', name: 'Done' },
      { ...data(archive), boardId, kind: 'archive', rank: null, name: 'Archive' },
      { ...data(trash), boardId, kind: 'trash', rank: null, name: 'Trash' },
    ];
  }

  return {
    generationId: ids.generation,
    users: [
      user(ids.admin, 'admin', 'admin'),
      user(ids.privateOwner, 'private-owner', 'projectOwner'),
      user(ids.createOnlyOwner, 'create-only-owner', 'projectOwner'),
      user(ids.projectManager, 'project-manager', 'boardUser'),
      user(ids.firstEditor, 'first-editor', 'boardUser'),
      user(ids.secondEditor, 'second-editor', 'boardUser', { username: null }),
      user(ids.viewer, 'viewer', 'boardUser'),
      user(ids.commentingViewer, 'commenting-viewer', 'boardUser'),
      user(ids.unrelated, 'unrelated', 'boardUser'),
      user(ids.disabledMember, 'disabled-member', 'boardUser', { disabled: true }),
    ],
    projects: [
      { ...data(ids.privateProject), name: 'Private fixture project', type: 'private', hidden: false, ownerProjectManagerId: ids.privateOwnerManager },
      { ...data(ids.sharedProject), name: 'Shared fixture project', type: 'shared', hidden: false, ownerProjectManagerId: null },
      { ...data(ids.hiddenProject), name: 'Hidden fixture project', type: 'shared', hidden: true, ownerProjectManagerId: null },
    ],
    projectManagers: [
      { ...data(ids.privateOwnerManager), projectId: ids.privateProject, userId: ids.privateOwner },
      { ...data(ids.privateManager), projectId: ids.privateProject, userId: ids.projectManager },
      { ...data(ids.sharedManager), projectId: ids.sharedProject, userId: ids.projectManager },
      { ...data(ids.hiddenManager), projectId: ids.hiddenProject, userId: ids.privateOwner },
    ],
    boards: [
      { ...data(ids.privateBoard), projectId: ids.privateProject, name: 'Transfer source', defaultView: 'kanban' },
      { ...data(ids.sharedBoard), projectId: ids.sharedProject, name: 'Transfer destination', defaultView: 'list' },
      { ...data(ids.hiddenBoard), projectId: ids.hiddenProject, name: 'Hidden board', defaultView: 'grid' },
    ],
    boardMembers: [
      membership(100, ids.privateBoard, ids.privateOwner, 'editor', null),
      membership(101, ids.privateBoard, ids.firstEditor, 'editor', null),
      membership(102, ids.privateBoard, ids.secondEditor, 'editor', null),
      membership(103, ids.privateBoard, ids.viewer, 'viewer', false),
      membership(104, ids.privateBoard, ids.commentingViewer, 'viewer', true),
      membership(105, ids.privateBoard, ids.disabledMember, 'editor', null),
      membership(106, ids.sharedBoard, ids.firstEditor, 'editor', null),
      membership(107, ids.hiddenBoard, ids.privateOwner, 'editor', null),
    ],
    lists: [
      ...listsFor(ids.privateBoard, [ids.privateActiveList, ids.privateClosedList, ids.privateArchive, ids.privateTrash]),
      ...listsFor(ids.sharedBoard, [ids.sharedActiveList, ids.sharedClosedList, ids.sharedArchive, ids.sharedTrash]),
      ...listsFor(ids.hiddenBoard, [ids.hiddenActiveList, ids.hiddenClosedList, ids.hiddenArchive, ids.hiddenTrash]),
    ],
    cards: [
      { ...data(ids.activeCard), boardId: ids.privateBoard, listId: ids.privateActiveList, previousListId: null, name: 'Moving an assigned card', type: 'project', rank: '1024' },
      // Models a historical reference to a deleted list so restore requires a destination.
      { ...data(ids.archivedStory), boardId: ids.privateBoard, listId: ids.privateArchive, previousListId: ids.removedPriorList, name: 'Story with a missing prior list', type: 'story', rank: null },
      { ...data(ids.trashedCard), boardId: ids.privateBoard, listId: ids.privateTrash, previousListId: ids.privateClosedList, name: 'Card in trash', type: 'project', rank: null },
      { ...data(ids.sharedTarget), boardId: ids.sharedBoard, listId: ids.sharedActiveList, previousListId: null, name: 'Cross-board linked target', type: 'project', rank: '1024' },
    ],
    // The second editor loses eligibility as an assignee after transfer to sharedBoard.
    cardAssignees: [{ ...data(fixtureId(110)), cardId: ids.activeCard, userId: ids.secondEditor }],
    checklists: [{ ...data(ids.checklist), cardId: ids.activeCard, name: 'Linked work', rank: '1024' }],
    // The private board viewer can read activeCard but cannot read sharedTarget.
    tasks: [{ ...data(ids.linkedTask), checklistId: ids.checklist, linkedCardId: ids.sharedTarget, completed: false, rank: '1024' }],
    fieldGroups: [{ ...data(ids.fieldGroup), boardId: ids.privateBoard, name: 'Release fields', rank: '1024' }],
    fieldDefinitions: [{ ...data(ids.fieldDefinition), groupId: ids.fieldGroup, name: 'Release note', rank: '1024' }],
    fieldValues: [{ ...data(ids.fieldValue), cardId: ids.activeCard, groupId: ids.fieldGroup, definitionId: ids.fieldDefinition, value: '  exact synthetic text  ' }],
  };
}
