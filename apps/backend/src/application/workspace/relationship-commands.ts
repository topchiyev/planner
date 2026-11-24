import { randomUUID } from 'node:crypto';
import { relationshipCommands, type RelationshipCommand, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandContext, CommandPlan, CommandPlanningContext, JournalFields, JournalOperation, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type ProjectAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { planMembershipCleanup } from './relationship-cleanup.js';
import {
  availableAccount, managerEdges, memberPermissions, RelationshipError, requireBoardManagement, requireRevision, soleEligibleManager, touchRevision,
} from './relationship-policy.js';
import { canonicalRow, createWorkspaceRecords, directBoardRole, equal, type WorkspaceRecords } from './records.js';

const invalidate = (boardId: string) => ({ boardId, kind: 'board.access-changed', payload: {} });

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
  if (input.name !== undefined || input.description !== undefined) requireCapability(authorized.permissions.canEdit);
  if (input.hidden !== undefined) requireCapability(authorized.permissions.canToggleHidden);
  if (input.type !== undefined) {
    if (authorized.project.type === 'private') requireCapability(authorized.ownsProject);
    else requireCapability(authorized.project.type === 'shared' && authorized.project.ownerProjectManagerId === null
      && (input.type === 'private' ? authorized.sharedAdmin : !!authorized.manager || authorized.sharedAdmin));
  }
  return authorized;
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
): Record<RelationshipCommand, JournalOperation> {
  function define<K extends RelationshipCommand, Scope extends ProjectAccessContext | BoardAccessContext>(
    operation: K,
    authorize: (actor: WorkspaceAuthorization, input: RelationshipCommandInput<K>) => Promise<Scope>,
    plan: (records: WorkspaceRecords, access: Scope, input: RelationshipCommandInput<K>, context: CommandPlanningContext) => Promise<CommandPlan>,
  ): JournalOperation {
    const parse = (input: unknown) => relationshipCommands[operation].input.parse(input) as RelationshipCommandInput<K>;
    return {
      normalize: (input) => Object.fromEntries(Object.entries(parse(input)).filter(([, value]) => value !== undefined)),
      async authorize(context, input) { await authorize(await resolveActor(context), parse(input)); },
      async plan(context, input) {
        const parsed = parse(input);
        const actor = await resolveActor(context);
        const access = await authorize(actor, parsed);
        const result = await plan(createWorkspaceRecords(database, context.generationId), access, parsed, context);
        return { ...result, audit: { ...result.audit, origin } };
      },
    };
  }

  return {
    'projects.update': define('projects.update', projectEdit, async (records, access, input, context) => {
      const project = access.project;
      const revision = requireRevision(project, input.revision, true)!;
      const fields: JournalFields = { updatedAt: context.timestamp };
      if (input.name !== undefined) fields.name = input.name;
      if (input.description !== undefined) fields.description = input.description;
      if (input.hidden !== undefined) fields.hidden = input.hidden;
      if (input.type !== undefined && input.type !== project.type) {
        fields.type = input.type;
        fields.ownerProjectManagerId = null;
        if (input.type === 'private') {
          const edge = await soleEligibleManager(records, context.generationId, input.id);
          if (!edge) throw new RelationshipError('ownership');
          fields.ownerProjectManagerId = edge.id;
        }
      }
      return {
        effects: [{ kind: 'update', collection: 'projects', id: input.id, revision, fields }],
        result: { data: { id: input.id, revision: revision + 1 } },
        audit: { action: 'projects.update', resourceId: input.id, resourceType: 'project' },
        events: await projectEvents(records, context.generationId, input.id),
      };
    }),
    'projects.addManager': define('projects.addManager', (scope, input) => managerAccess(scope, input.id),
      async (records, access, input, context) => {
        if (!availableAccount(await records.get('users', input.userId), 'manager')) throw new RelationshipError('target');
        if (await records.first('projectManagers', edgeFilter('projectId', input.id, input.userId))) throw new RelationshipError('duplicate');
        const id = randomUUID();
        return {
          effects: [
            { kind: 'insert', collection: 'projectManagers', id, revision: 1,
              fields: { projectId: input.id, userId: input.userId, createdAt: context.timestamp } },
            touchRevision('projects', access.project, context.timestamp),
          ],
          result: { data: { id, revision: 1 } },
          audit: { action: 'projects.addManager', resourceId: input.id, resourceType: 'project', detail: { userId: input.userId } },
          events: await projectEvents(records, context.generationId, input.id),
        };
      }),
    'projects.removeManager': define('projects.removeManager', (scope, input) => managerAccess(scope, input.id),
      async (records, access, input, context) => {
        const edge = await records.first('projectManagers', edgeFilter('projectId', input.id, input.userId));
        if (!edge) throw new WorkspaceAccessError('missing');
        const revision = requireRevision(edge, input.revision);
        if ((await managerEdges(records, context.generationId, input.id)).length < 2) throw new RelationshipError('lastManager');
        return {
          effects: [
            { kind: 'delete', collection: 'projectManagers', id: edge.id, revision },
            touchRevision('projects', access.project, context.timestamp),
          ],
          result: { data: { id: edge.id } },
          audit: { action: 'projects.removeManager', resourceId: input.id, resourceType: 'project', detail: { userId: input.userId } },
          events: await projectEvents(records, context.generationId, input.id),
        };
      }),
    'boards.addMember': define('boards.addMember', (scope, input) => boardManagement(scope, input.id, input.userId),
      async (records, access, input, context) => {
        if (!availableAccount(await records.get('users', input.userId), 'member')) throw new RelationshipError('target');
        if (await records.first('boardMembers', edgeFilter('boardId', input.id, input.userId))) throw new RelationshipError('duplicate');
        const id = randomUUID();
        return {
          effects: [
            { kind: 'insert', collection: 'boardMembers', id, revision: 1, fields: {
              boardId: input.id, userId: input.userId, role: input.role, canComment: input.canComment, createdAt: context.timestamp,
            } },
            touchRevision('boards', access.board, context.timestamp),
          ],
          result: { data: { id, revision: 1 } },
          audit: { action: 'boards.addMember', resourceId: input.id, resourceType: 'board', detail: { userId: input.userId } },
          events: [invalidate(input.id)],
        };
      }),
    'boards.updateMember': define('boards.updateMember', (scope, input) => boardManagement(scope, input.id),
      async (records, access, input, context) => {
        const edge = await memberEdge(records, input.id, input.userId);
        const revision = requireRevision(edge, input.revision, true);
        const membership = memberPermissions(input.role ?? edge.role, input.canComment, edge.role === 'viewer' && edge.canComment === true);
        return {
          effects: [
            { kind: 'update', collection: 'boardMembers', id: edge.id, revision, fields: { ...membership, updatedAt: context.timestamp } },
            touchRevision('boards', access.board, context.timestamp),
          ],
          result: { data: { id: edge.id, revision: (revision ?? 0) + 1 } },
          audit: { action: 'boards.updateMember', resourceId: input.id, resourceType: 'board', detail: { userId: input.userId } },
          events: [invalidate(input.id)],
        };
      }),
    'boards.removeMember': define('boards.removeMember', boardRemoval,
      async (records, access, input, context) => {
        const edge = await memberEdge(records, input.id, input.userId);
        const revision = requireRevision(edge, input.revision);
        const cleanup = await planMembershipCleanup(records, context.generationId, input.id, input.userId, context.timestamp);
        const removal: PlannedEffect = { kind: 'delete', collection: 'boardMembers', id: edge.id, revision };
        return {
          effects: [removal, touchRevision('boards', access.board, context.timestamp), ...cleanup],
          result: { data: { id: edge.id } },
          audit: { action: 'boards.removeMember', resourceId: input.id, resourceType: 'board', detail: { userId: input.userId } },
          events: [invalidate(input.id)],
        };
      }),
  };
}
