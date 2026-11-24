import type { BoardAccess, CardAccess, ProjectAccess, SessionActor } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db, Document } from 'mongodb';
import { loadCurrentBrowserSession } from '../auth/sessions.js';
import { CleanCommandRejection } from '../command-gate/gate.js';
import { resolveFieldTemplate } from './field-state.js';
import { canonicalRow, createWorkspaceRecords, directBoardRole, equal, rankSort, together, type WorkspaceRow } from './records.js';

const errors = {
  session: [401, 'UNAUTHENTICATED', 'Sign in to continue.'],
  missing: [404, 'NOT_FOUND', 'The workspace resource is unavailable.'],
  forbidden: [403, 'FORBIDDEN', 'You do not have permission for this action.'],
} as const;

export class WorkspaceAccessError extends CleanCommandRejection {
  readonly statusCode: number;
  readonly code: string;

  constructor(kind: keyof typeof errors) {
    const [statusCode, code, message] = errors[kind];
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function requireCapability(allowed: boolean) {
  if (!allowed) throw new WorkspaceAccessError('forbidden');
}

function found<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new WorkspaceAccessError('missing');
  return value;
}

function reference(value: unknown) {
  const id = publicIdSchema.safeParse(value);
  return found(id.success ? id.data : null);
}

const ownerlessSharedProject = (prefix = '$') => ({ $expr: { $and: [
  { $eq: [prefix + 'type', 'shared'] }, { $eq: [{ $type: prefix + 'ownerProjectManagerId' }, 'null'] },
] } });
const isDirectMember = (member: WorkspaceRow<'boardMembers'> | null) => member?.role === 'editor' || member?.role === 'viewer';

type Project = WorkspaceRow<'projects'>;
type Board = WorkspaceRow<'boards'>;
type Card = WorkspaceRow<'cards'>;
type List = WorkspaceRow<'lists'>;
type Membership = WorkspaceRow<'boardMembers'>;
type FieldGroup = WorkspaceRow<'fieldGroups'>;
type ProjectManager = WorkspaceRow<'projectManagers'>;

export interface ProjectAccessContext {
  project: Project;
  manager: ProjectManager | null;
  ownsProject: boolean;
  sharedAdmin: boolean;
  permissions: ProjectAccess;
}
export interface BoardAccessContext {
  board: Board;
  project: ProjectAccessContext;
  membership: Membership | null;
  permissions: BoardAccess;
}
export interface CardAccessContext {
  card: Card;
  list: List;
  board: BoardAccessContext;
  permissions: CardAccess;
}

export type WorkspaceActor = Readonly<Pick<SessionActor, 'id' | 'role'>>;

export function cardContextForList(list: List): Card['kind'] {
  if (list.kind === 'archive' || list.kind === 'trash') return list.kind;
  if (list.kind === 'active' || list.kind === 'closed') return 'board';
  throw new WorkspaceAccessError('missing');
}

export function cardPermissions(board: BoardAccessContext, list: List): CardAccess {
  const ordinary = cardContextForList(list) === 'board';
  const edit = board.permissions.canEdit;
  return {
    canEdit: ordinary && edit,
    canComment: ordinary && board.permissions.canComment,
    canFollow: board.permissions.canFollow,
    canDuplicateFrom: ordinary && board.permissions.canDuplicateFrom,
    canMove: edit,
    canArchive: ordinary && edit,
    canTrash: list.kind !== 'trash' && edit,
    canRestore: !ordinary && edit,
    canPurge: list.kind === 'trash' && edit,
  };
}

// The caller holds a read or command lease until it finishes materializing the result or planning a write.
export async function resolveBrowserWorkspace(database: Db, installationId: string, token: string, now: Date) {
  const session = await loadCurrentBrowserSession(database, installationId, token, now);
  if (!session) throw new WorkspaceAccessError('session');
  return Object.freeze({
    ...createWorkspaceAuthorization(database, session.generationId, session.account.actor),
    sessionDeadline: session.deadline,
  });
}

// For trusted adapters with an already verified current actor and active generation under the same lease.
export function createWorkspaceAuthorization(database: Db, generationId: string, actor: WorkspaceActor) {
  const records = createWorkspaceRecords(database, generationId);
  const roles = Object.freeze({ siteAdmin: actor.role === 'admin', canCreateProject: actor.role === 'admin' || actor.role === 'projectOwner' });
  const principal = Object.freeze({ id: actor.id, role: actor.role });

  function projectAccess(project: Project, manager: ProjectManager | null): ProjectAccessContext {
    const ownsProject = !!manager && project.type === 'private' && project.ownerProjectManagerId === manager.id;
    const sharedAdmin = roles.siteAdmin && project.type === 'shared' && project.ownerProjectManagerId === null;
    return {
      project, manager, ownsProject, sharedAdmin,
      permissions: {
        canEdit: !!manager, canToggleHidden: !!manager || sharedAdmin,
        canChangeOwnership: ownsProject || sharedAdmin, canCreateBoard: !!manager,
        canManageManagers: project.type === 'shared' && project.ownerProjectManagerId === null && (!!manager || sharedAdmin),
        canDelete: !!manager, canFavorite: true,
      },
    };
  }

  function boardAccess(board: Board, project: ProjectAccessContext, membership: Membership | null): BoardAccessContext {
    if (!project.manager && !project.sharedAdmin && !isDirectMember(membership)) throw new WorkspaceAccessError('missing');
    const canEdit = membership?.role === 'editor';
    return {
      board, project, membership,
      permissions: {
        canManage: !!project.manager, canEdit,
        canComment: canEdit || (membership?.role === 'viewer' && membership.canComment === true),
        canFollow: isDirectMember(membership),
        canDuplicateFrom: !!project.manager || canEdit,
        canClearTrash: !!project.manager || canEdit,
      },
    };
  }

  const canonical = canonicalRow(generationId);
  const exactActorEdge = [canonical, equal('userId', principal.id)];
  const actorManager = (projectId: string) => ({
    userId: principal.id, $expr: { $and: [...exactActorEdge, equal('projectId', projectId)] },
  });
  const actorMember = (boardId: string) => ({
    userId: principal.id, $expr: { $and: [...exactActorEdge, equal('boardId', boardId), directBoardRole] },
  });
  const managerRow = (project: Project) => records.first('projectManagers', { projectId: project.id, ...actorManager(project.id) });
  const membershipRow = (board: Board) => records.first('boardMembers', { boardId: board.id, ...actorMember(board.id) });

  // Match a linked target inside a paginated board query without inspecting private rows in the result.
  function readableCardLookup(as: string, from: string, summary = false) {
    return records.lookup('cards', as, { targetId: from }, {
      $expr: { $and: [canonical, equal('id', '$$targetId')] },
    }, [
      records.lookup('lists', 'targetPlacement', { listId: '$listId', boardId: '$boardId', cardKind: '$kind' }, {
        $expr: { $and: [canonical, equal('id', '$$listId'), equal('boardId', '$$boardId'), {
          $or: [
            { $and: [{ $in: ['$kind', ['active', 'closed']] }, { $eq: ['$$cardKind', 'board'] }] },
            { $and: [{ $in: ['$kind', ['archive', 'trash']] }, equal('kind', '$$cardKind')] },
          ],
        }] },
      }, [{ $limit: 1 }]),
      { $match: { 'targetPlacement.0': { $exists: true } } },
      records.lookup('boards', 'readableTargetBoard', { boardId: '$boardId' }, {
        $expr: { $and: [canonical, equal('id', '$$boardId')] },
      }, [
        records.lookup('boardMembers', 'actorMembership', { boardId: '$id' }, actorMember('$$boardId'), [{ $limit: 1 }]),
        records.lookup('projects', 'targetProject', { projectId: '$projectId' }, {
          $expr: { $and: [canonical, equal('id', '$$projectId')] },
        }, [
          records.lookup('projectManagers', 'actorManager', { projectId: '$id' }, actorManager('$$projectId'), [{ $limit: 1 }]),
        ]),
        { $unwind: '$targetProject' },
        { $match: { $or: [
          { 'actorMembership.0': { $exists: true } }, { 'targetProject.actorManager.0': { $exists: true } },
          ...(roles.siteAdmin ? [ownerlessSharedProject('$targetProject.')] : []),
        ] } },
        { $project: { _id: 1 } },
      ]),
      { $match: { 'readableTargetBoard.0': { $exists: true } } },
      { $project: summary ? { _id: 0, id: 1, name: 1, boardId: 1, kind: 1, transferredAcrossBoards: 1 } : { _id: 1 } },
    ]);
  }

  function visibleBoards(project: ProjectAccessContext) {
    const id = project.project.id;
    const filter = { projectId: id, $expr: { $and: [equal('projectId', id), canonical] } };
    if (project.manager || project.sharedAdmin) return records.find('boards', filter, rankSort);
    return records.aggregate<Board>('boards', filter, [
      records.lookup('boardMembers', 'actorMembership', { boardId: '$id' }, actorMember('$$boardId'), [{ $limit: 1 }]),
      { $match: { 'actorMembership.0': { $exists: true } } },
      { $sort: rankSort },
      { $unset: 'actorMembership' },
    ]);
  }

  async function requireProject(id: string) {
    const project = found(await records.get('projects', id));
    const permissions = projectAccess(project, await managerRow(project));
    if (!permissions.manager && !permissions.sharedAdmin && !(await visibleBoards(permissions)).length) {
      throw new WorkspaceAccessError('missing');
    }
    return permissions;
  }

  function visibleProjectStages(): Document[] {
    const hasManager = { 'actorManager.0': { $exists: true } };
    const hasBoard = { 'memberBoard.0': { $exists: true } };
    return [
      { $match: { $expr: canonical } },
      records.lookup('projectManagers', 'actorManager', { projectId: '$id' }, actorManager('$$projectId'), [{ $limit: 1 }]),
      records.lookup('boards', 'memberBoard', { projectId: '$id' }, {
        $expr: { $and: [canonical, { $eq: ['$projectId', '$$projectId'] }] },
      }, [
        records.lookup('boardMembers', 'actorMembership', { boardId: '$id' }, actorMember('$$boardId'), [{ $limit: 1 }]),
        { $match: { 'actorMembership.0': { $exists: true } } },
        { $limit: 1 },
      ]),
      { $match: { $or: [hasManager, hasBoard, ...(roles.siteAdmin ? [ownerlessSharedProject()] : [])] } },
      { $unset: ['actorManager', 'memberBoard'] },
    ];
  }

  async function requireBoard(id: string, expectedProjectId?: string) {
    const board = found(await records.get('boards', id));
    if (expectedProjectId && board.projectId !== expectedProjectId) throw new WorkspaceAccessError('missing');
    const project = found(await records.get('projects', reference(board.projectId)));
    const [manager, member] = await together([managerRow(project), membershipRow(board)]);
    return boardAccess(board, projectAccess(project, manager), member);
  }

  async function requireList(id: string, expectedBoardId?: string) {
    const list = found(await records.get('lists', id));
    if (expectedBoardId && list.boardId !== expectedBoardId) throw new WorkspaceAccessError('missing');
    const board = await requireBoard(reference(list.boardId));
    cardContextForList(list);
    return { list, board };
  }

  async function requireCard(id: string, expectedBoardId?: string) {
    const card = found(await records.get('cards', id));
    if (expectedBoardId && card.boardId !== expectedBoardId) throw new WorkspaceAccessError('missing');
    const { list, board } = await requireList(reference(card.listId), reference(card.boardId));
    if (card.kind !== cardContextForList(list)) throw new WorkspaceAccessError('missing');
    return { card, list, board, permissions: cardPermissions(board, list) };
  }

  async function requireComment(id: string) {
    const comment = found(await records.get('comments', id));
    return { comment, card: await requireCard(reference(comment.cardId), reference(comment.boardId)) };
  }

  async function requireAttachment(id: string) {
    const attachment = found(await records.get('attachments', id));
    if (attachment.deletedAt != null) throw new WorkspaceAccessError('missing');
    return { attachment, card: await requireCard(reference(attachment.cardId)) };
  }

  async function requireLabel(id: string, expectedBoardId?: string) {
    const label = found(await records.get('labels', id));
    if (expectedBoardId && label.boardId !== expectedBoardId) throw new WorkspaceAccessError('missing');
    return { label, board: await requireBoard(reference(label.boardId)) };
  }

  async function requireChecklist(id: string, expectedCardId?: string) {
    const checklist = found(await records.get('checklists', id));
    if (expectedCardId && checklist.cardId !== expectedCardId) throw new WorkspaceAccessError('missing');
    return { checklist, card: await requireCard(reference(checklist.cardId)) };
  }

  async function requireTask(id: string, expectedChecklistId?: string) {
    const task = found(await records.get('tasks', id));
    if (expectedChecklistId && task.checklistId !== expectedChecklistId) throw new WorkspaceAccessError('missing');
    return { task, ...(await requireChecklist(reference(task.checklistId))) };
  }

  async function requireFieldGroup(id: string) {
    const group = found(await records.get('fieldGroups', id));
    if (group.scopeType === 'card') return { group, scope: 'card' as const, ...(await requireCard(reference(group.scopeId))) };
    if (group.scopeType === 'board') return { group, scope: 'board' as const, ...(await requireBoard(reference(group.scopeId))) };
    if (group.scopeType !== 'project') throw new WorkspaceAccessError('missing');
    const project = await requireProject(reference(group.scopeId));
    if (!project.manager) throw new WorkspaceAccessError('missing');
    return { group, scope: 'project' as const, ...project };
  }

  async function requireFieldDefinition(id: string) {
    const definition = found(await records.get('fieldDefinitions', id));
    return { definition, ...(await requireFieldGroup(reference(definition.fieldGroupId))) };
  }

  async function effectiveDefinitionGroups(card: CardAccessContext, group: FieldGroup) {
    if ((group.scopeType !== 'board' || group.scopeId !== card.board.board.id)
        && (group.scopeType !== 'card' || group.scopeId !== card.card.id)) throw new WorkspaceAccessError('missing');
    const template = await resolveFieldTemplate(records, group, card.board.project.project.id);
    if (!template && typeof group.name !== 'string') throw new WorkspaceAccessError('missing');
    return template ? [group.id, template.id] : [group.id];
  }

  async function requireCardField(cardId: string, groupId: string, definitionId: string) {
    const card = await requireCard(cardId);
    const group = found(await records.get('fieldGroups', groupId));
    const allowed = await effectiveDefinitionGroups(card, group);
    const definition = found(await records.get('fieldDefinitions', definitionId));
    if (!allowed.includes(definition.fieldGroupId)) throw new WorkspaceAccessError('missing');
    return { card, group, definition };
  }

  return Object.freeze({
    generationId, actor: principal, roles,
    requireProject, requireBoard, requireList, requireCard, requireComment, requireAttachment, requireLabel,
    requireChecklist, requireTask, requireFieldGroup, requireFieldDefinition, requireCardField,
    projectAccess, boardAccess, membershipRow, managerRow, visibleBoards, visibleProjectStages, effectiveDefinitionGroups, readableCardLookup,
  });
}

export type WorkspaceAuthorization = ReturnType<typeof createWorkspaceAuthorization>;
