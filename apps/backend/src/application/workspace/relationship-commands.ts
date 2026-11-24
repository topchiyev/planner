import { randomUUID } from 'node:crypto';
import { relationshipCommands, type RelationshipBoardInvalidation, type RelationshipCommand, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandContext, CommandPlan, CommandPlanningContext, JournalFields, JournalOperation, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type ProjectAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { authorizeListCreate, authorizeListEdit, authorizeListMove, planListCreate, planListMove, planListUpdate } from './list-lifecycle.js';
import { availableProjectImage } from './project-background.js';
import { authorizeProjectDelete, planProjectCreate, planProjectDelete } from './project-lifecycle.js';
import {
  authorizeBoardCreate, authorizeBoardDelete, authorizeBoardManage, planBoardCreate, planBoardDelete, planBoardMove, planBoardUpdate,
} from './board-lifecycle.js';
import { planMembershipCleanup } from './relationship-cleanup.js';
import {
  availableAccount, managerEdges, memberPermissions, projectFavoriteFilter, RelationshipError, requireBoardManagement, requireRevision, rowRevision, soleEligibleManager, touchRevision,
} from './relationship-policy.js';
import { canonicalRow, createWorkspaceRecords, directBoardRole, equal, type WorkspaceRecords } from './records.js';

const invalidate = (boardId: string): RelationshipBoardInvalidation => ({ boardId, kind: 'board.access-changed', payload: {} });

async function projectEvents(records: WorkspaceRecords, generationId: string, projectId: string) {
  const boards = await records.aggregate<{ id: string }>('boards', {
    projectId, $expr: { $and: [equal('projectId', projectId), canonicalRow(generationId)] },
  }, [{ $sort: { id: 1 } }, { $project: { _id: 0, id: 1 } }]);
  return boards.map(({ id }) => invalidate(id));
}

function edgeFilter(parent: 'boardId' | 'projectId', id: string, userId: string) {
  return { [parent]: id, userId, $expr: { $and: [equal(parent, id), equal('userId', userId)] } };
}

async function memberEdge(records: WorkspaceRecords, boardId: string, userId: string) {
  const member = await records.first('boardMembers', {
    ...edgeFilter('boardId', boardId, userId),
    $expr: { $and: [equal('boardId', boardId), equal('userId', userId), directBoardRole] },
  });
  if (!member) throw new WorkspaceAccessError('missing');
  return member;
}

async function projectEdit(scope: WorkspaceAuthorization, input: RelationshipCommandInput<'projects.update'>) {
  const authorized = await scope.requireProject(input.id);
  if (input.name !== undefined || input.description !== undefined || input.background !== undefined) requireCapability(authorized.permissions.canEdit);
  if (input.hidden !== undefined) requireCapability(authorized.permissions.canToggleHidden);
  if (input.type !== undefined) {
    if (authorized.project.type === 'private') requireCapability(authorized.ownsProject);
    else requireCapability(authorized.project.type === 'shared' && authorized.project.ownerProjectManagerId === null
      && (input.type === 'private' ? authorized.sharedAdmin : !!authorized.manager || authorized.sharedAdmin));
  }
  return authorized;
}

async function favoriteAccess(scope: WorkspaceAuthorization, input: RelationshipCommandInput<'projects.favorite'>) {
  const project = await scope.requireProject(input.id);
  requireCapability(project.permissions.canFavorite);
  return project;
}

async function changeFavorite(
  favorite: boolean, records: WorkspaceRecords, access: ProjectAccessContext,
  input: RelationshipCommandInput<'projects.favorite'>, context: CommandPlanningContext,
): Promise<CommandPlan> {
  const { actorId: userId, generationId, timestamp } = context;
  const revision = requireRevision(access.project, input.expectedRevision)!;
  const edge = await records.first('projectFavorites', projectFavoriteFilter(generationId, input.id, userId));
  const effects: PlannedEffect[] = [];
  if (favorite && !edge) effects.push({ kind: 'insert', collection: 'projectFavorites', id: randomUUID(),
    fields: { projectId: input.id, userId, createdAt: timestamp } });
  if (!favorite && edge) effects.push({ kind: 'delete', collection: 'projectFavorites', id: edge.id, revision: rowRevision(edge) });
  return { effects, result: { data: { id: input.id, revision, favorite } },
    audit: { resourceId: userId, resourceType: 'account', action: favorite ? 'projects.favorite' : 'projects.unfavorite' } };
}

async function managerAccess(scope: WorkspaceAuthorization, id: string) {
  const project = await scope.requireProject(id);
  requireCapability(project.permissions.canManageManagers);
  return project;
}

async function boardManagement(scope: WorkspaceAuthorization, id: string, targetId?: string) {
  const board = await scope.requireBoard(id);
  requireBoardManagement(scope, board, targetId);
  return board;
}

async function boardRemoval(scope: WorkspaceAuthorization, input: RelationshipCommandInput<'boards.removeMember'>) {
  const board = await scope.requireBoard(input.id);
  // A self-removal retry can still be acknowledged if another current read path survives.
  requireCapability(board.permissions.canManage || scope.actor.id === input.userId);
  return board;
}

export function createRelationshipJournalOperations(
  database: Db,
  resolveActor: (context: CommandContext) => Promise<WorkspaceAuthorization>,
  origin: 'web' | 'mcp' = 'web',
  idempotencyKey?: string,
): Record<RelationshipCommand, JournalOperation> {
  function define<K extends RelationshipCommand, Scope>(
    operation: K,
    authorize: (actor: WorkspaceAuthorization, input: RelationshipCommandInput<K>) => Promise<Scope>,
    plan: (records: WorkspaceRecords, access: Scope, input: RelationshipCommandInput<K>, context: CommandPlanningContext,
      actor: WorkspaceAuthorization) => Promise<CommandPlan>,
  ): JournalOperation {
    const parse = (input: unknown) => relationshipCommands[operation].input.parse(input) as RelationshipCommandInput<K>;
    return {
      normalize: (input) => Object.fromEntries(Object.entries(parse(input)).filter(([, value]) => value !== undefined)),
      async authorize(context, input) { await authorize(await resolveActor(context), parse(input)); },
      async plan(context, input) {
        const parsed = parse(input);
        const actor = await resolveActor(context);
        const access = await authorize(actor, parsed);
        const result = await plan(createWorkspaceRecords(database, context.generationId), access, parsed, context, actor);
        relationshipCommands[operation].output.parse(result.result);
        return { ...result, audit: { ...result.audit, origin } };
      },
    };
  }

  return {
    'lists.create': define('lists.create', (scope, input) => authorizeListCreate(scope, input.id), planListCreate),
    'lists.update': define('lists.update', (scope, input) => authorizeListEdit(scope, input.id), planListUpdate),
    'lists.move': define('lists.move', authorizeListMove, planListMove),
    'boards.create': define('boards.create', (scope, input) => authorizeBoardCreate(scope, input.id),
      (_records, project, input, context, scope) => planBoardCreate(project, input, context, scope)),
    'boards.move': define('boards.move', (scope, input) => authorizeBoardManage(scope, input.id),
      (_records, board, input, context, scope) => planBoardMove(board, input, context, scope)),
    'boards.update': define('boards.update', (scope, input) => authorizeBoardManage(scope, input.id), planBoardUpdate),
    'boards.delete': define('boards.delete', (scope, input) => authorizeBoardDelete(database, scope, input, origin, idempotencyKey),
      planBoardDelete),
    'projects.create': define('projects.create', async (scope) => { requireCapability(scope.roles.canCreateProject); },
      (records, _access, input, context) => planProjectCreate(records, input, context)),
    'projects.delete': define('projects.delete', (scope, input) => authorizeProjectDelete(database, scope, input, idempotencyKey),
      (records, _access, input, _context, actor) => planProjectDelete(records, actor, input)),
    'projects.favorite': define('projects.favorite', favoriteAccess,
      (records, access, input, context) => changeFavorite(true, records, access, input, context)),
    'projects.unfavorite': define('projects.unfavorite', favoriteAccess,
      (records, access, input, context) => changeFavorite(false, records, access, input, context)),
    'projects.update': define('projects.update', projectEdit, async (records, access, input, context, actor): Promise<CommandPlan> => {
      const project = access.project;
      const revision = requireRevision(project, input.expectedRevision, true)!;
      const fields: JournalFields = { updatedAt: context.timestamp };
      if (input.name !== undefined) fields.name = input.name;
      if (input.description !== undefined) fields.description = input.description;
      if (input.hidden !== undefined) fields.hidden = input.hidden;
      if (input.background !== undefined) {
        if (input.background?.kind === 'image' && !await availableProjectImage(database, context.generationId, input.id, input.background.id)) {
          throw new RelationshipError('background');
        }
        fields.backgroundId = input.background?.kind === 'image' ? input.background.id : null;
        fields.backgroundPreset = input.background?.kind === 'preset' ? input.background.preset : null;
      }
      let retainsRead = true;
      if (input.type !== undefined && input.type !== project.type) {
        fields.type = input.type;
        fields.ownerProjectManagerId = null;
        if (input.type === 'private') {
          const edge = await soleEligibleManager(records, context.generationId, input.id);
          if (!edge) throw new RelationshipError('ownership');
          fields.ownerProjectManagerId = edge.id;
          retainsRead = !!access.manager || (await actor.visibleBoards({ ...access, sharedAdmin: false })).length > 0;
        }
      }
      return {
        effects: [{ kind: 'update', collection: 'projects', id: input.id, revision, fields }],
        result: { data: retainsRead ? {
          id: input.id, revision: revision + 1, name: input.name ?? project.name,
          description: input.description === undefined ? project.description ?? null : input.description,
          hidden: input.hidden ?? project.hidden, type: input.type ?? project.type,
        } : { id: input.id, applied: true } },
        audit: { action: 'projects.update', resourceId: input.id, resourceType: 'project' },
        events: await projectEvents(records, context.generationId, input.id),
      };
    }),
    'projects.addManager': define('projects.addManager', (scope, input) => managerAccess(scope, input.id),
      async (records, access, input, context) => {
        if (!availableAccount(await records.get('users', input.userId), 'manager')) throw new RelationshipError('target');
        if (await records.first('projectManagers', edgeFilter('projectId', input.id, input.userId))) throw new RelationshipError('duplicate');
        const id = randomUUID();
        const parent = touchRevision('projects', access.project, context.timestamp, input.expectedRevision);
        return {
          effects: [
            { kind: 'insert', collection: 'projectManagers', id, revision: 1,
              fields: { projectId: input.id, userId: input.userId, createdAt: context.timestamp } },
            parent,
          ],
          result: { data: {
            id, userId: input.userId, projectId: input.id, revision: 1, parentRevision: parent.revision + 1,
          } },
          audit: { action: 'projects.addManager', resourceId: input.id, resourceType: 'project', detail: { userId: input.userId } },
          events: await projectEvents(records, context.generationId, input.id),
        };
      }),
    'projects.removeManager': define('projects.removeManager', (scope, input) => managerAccess(scope, input.id),
      async (records, access, input, context, actor) => {
        const edge = await records.first('projectManagers', edgeFilter('projectId', input.id, input.userId));
        if (!edge) throw new WorkspaceAccessError('missing');
        const revision = requireRevision(edge, input.expectedRevision);
        if ((await managerEdges(records, context.generationId, input.id)).length < 2) throw new RelationshipError('lastManager');
        const parent = touchRevision('projects', access.project, context.timestamp);
        const retainsRead = input.userId !== context.actorId || access.sharedAdmin
          || (await actor.visibleBoards({ ...access, manager: null })).length > 0;
        return {
          effects: [
            { kind: 'delete', collection: 'projectManagers', id: edge.id, revision },
            parent,
          ],
          result: { data: { parentRevision: retainsRead ? parent.revision + 1 : null } },
          audit: { action: 'projects.removeManager', resourceId: input.id, resourceType: 'project', detail: { userId: input.userId } },
          events: await projectEvents(records, context.generationId, input.id),
        };
      }),
    'boards.addMember': define('boards.addMember', (scope, input) => boardManagement(scope, input.id, input.userId),
      async (records, access, input, context) => {
        if (!availableAccount(await records.get('users', input.userId), 'member')) throw new RelationshipError('target');
        if (await records.first('boardMembers', edgeFilter('boardId', input.id, input.userId))) throw new RelationshipError('duplicate');
        const id = randomUUID();
        const parent = touchRevision('boards', access.board, context.timestamp, input.expectedRevision);
        return {
          effects: [
            { kind: 'insert', collection: 'boardMembers', id, revision: 1, fields: {
              boardId: input.id, userId: input.userId, role: input.role, canComment: input.canComment, createdAt: context.timestamp,
            } },
            parent,
          ],
          result: { data: {
            id, userId: input.userId, boardId: input.id, revision: 1, parentRevision: parent.revision + 1, role: input.role, canComment: input.canComment,
          } },
          audit: { action: 'boards.addMember', resourceId: input.id, resourceType: 'board', detail: { userId: input.userId } },
          events: [invalidate(input.id)],
        };
      }),
    'boards.updateMember': define('boards.updateMember', (scope, input) => boardManagement(scope, input.id),
      async (records, access, input, context) => {
        const edge = await memberEdge(records, input.id, input.userId);
        const revision = requireRevision(edge, input.expectedRevision, true);
        const membership = memberPermissions(input.role ?? edge.role, input.canComment, edge.role === 'viewer' && edge.canComment === true);
        const parent = touchRevision('boards', access.board, context.timestamp);
        return {
          effects: [
            { kind: 'update', collection: 'boardMembers', id: edge.id, revision, fields: { ...membership, updatedAt: context.timestamp } },
            parent,
          ],
          result: { data: {
            id: edge.id, userId: input.userId, boardId: input.id, ...membership, revision: (revision ?? 0) + 1,
            parentRevision: parent.revision + 1,
          } },
          audit: { action: 'boards.updateMember', resourceId: input.id, resourceType: 'board', detail: { userId: input.userId } },
          events: [invalidate(input.id)],
        };
      }),
    'boards.removeMember': define('boards.removeMember', boardRemoval,
      async (records, access, input, context) => {
        const edge = await memberEdge(records, input.id, input.userId);
        const revision = requireRevision(edge, input.expectedRevision);
        const cleanup = await planMembershipCleanup(records, context.generationId, input.id, input.userId, context.timestamp);
        const removal: PlannedEffect = { kind: 'delete', collection: 'boardMembers', id: edge.id, revision };
        const parent = touchRevision('boards', access.board, context.timestamp);
        const retainsRead = !!access.project.manager || access.project.sharedAdmin;
        return {
          effects: [removal, parent, ...cleanup],
          result: { data: { parentRevision: retainsRead ? parent.revision + 1 : null } },
          audit: { action: 'boards.removeMember', resourceId: input.id, resourceType: 'board', detail: { userId: input.userId } },
          events: [invalidate(input.id)],
        };
      }),
  };
}
