import { randomUUID } from 'node:crypto';
import { boardDeleteReceipt, type RelationshipCommandInput } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { decodeRank, encodeRank, workspaceKey } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type ProjectAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { planBoardDescendants } from './board-deletion.js';
import { boardPreferences, boardPreferencesRow, boardShape, projectBoardOrderVersion } from './board-state.js';
import { readTerminalDeletionReceipt } from './deletion-receipt.js';
import { planRankChange, RankAnchorError } from './ordered-ranks.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';

const invalidate = (boardId: string) => ({ boardId, kind: 'board.invalidated', payload: {} } as const);
const audit = (action: string, resourceId: string) => ({ action, resourceId, resourceType: 'board' });

export async function authorizeBoardCreate(scope: WorkspaceAuthorization, id: string) {
  const project = await scope.requireProject(id);
  requireCapability(project.permissions.canCreateBoard);
  return project;
}

export async function authorizeBoardManage(scope: WorkspaceAuthorization, id: string) {
  const board = await scope.requireBoard(id);
  requireCapability(board.permissions.canManage);
  return board;
}

function advanceBoardOrder(project: WorkspaceRow<'projects'>, timestamp: string, expected = project.revision) {
  const effect = touchRevision('projects', project, timestamp, expected);
  const version = revisionSchema.safeParse(projectBoardOrderVersion(project) + 1);
  if (!version.success) throw new RelationshipError('boardOrder');
  return { ...effect, fields: { ...effect.fields, boardOrderVersion: version.data } };
}

function changeBoardRanks(rows: WorkspaceRow<'boards'>[], id: string, before: string | null) {
  try {
    return planRankChange(rows.map((row) => ({ id: row.id, rank: row.rank == null ? null : decodeRank(row.rank) })), id, before);
  } catch (error) {
    if (error instanceof RankAnchorError) throw new RelationshipError('boardOrder');
    throw error;
  }
}

function rankEffect(board: WorkspaceRow<'boards'>, rank: bigint | null, timestamp: string) {
  const touch = touchRevision('boards', board, timestamp);
  return { ...touch, fields: { ...touch.fields, rank: rank?.toString() ?? null } };
}

export async function planBoardCreate(
  project: ProjectAccessContext, input: RelationshipCommandInput<'boards.create'>, context: CommandPlanningContext,
  scope: WorkspaceAuthorization,
): Promise<CommandPlan> {
  const { generationId, actorId: userId, timestamp } = context;
  const projectId = project.project.id;
  const parent = advanceBoardOrder(project.project, timestamp, input.expectedRevision);
  const id = randomUUID();
  const boards = await scope.visibleBoards(project);
  const ranks = new Map(changeBoardRanks(boards, id, null).map((row) => [row.id, row.rank]));
  const rank = ranks.get(id);
  if (rank === undefined) throw new Error('The board append must have a rank.');
  const fields = { projectId, name: input.name, defaultView: 'kanban' as const, orderVersion: 1 };
  const membershipFields = { boardId: id, userId, role: 'editor' as const, canComment: null };
  const membershipId = randomUUID();
  const createdAt = new Date(timestamp);
  const board = { ...fields, _id: workspaceKey(generationId, id), id, generationId, createdAt, revision: 1, rank: encodeRank(rank) };
  const membership = { ...membershipFields, _id: workspaceKey(generationId, membershipId), id: membershipId, generationId, createdAt, revision: 1 };
  const { revision: _revision, ...preferences } = boardPreferences(board);
  const effects: PlannedEffect[] = [
    { kind: 'insert', collection: 'boards', id, fields: { ...fields, rank: rank.toString(), createdAt: timestamp, updatedAt: null } },
    { kind: 'insert', collection: 'boardMembers', id: membershipId, revision: 1, fields: { ...membershipFields, createdAt: timestamp } },
    { kind: 'insert', collection: 'boardPreferences', id: randomUUID(), fields: { boardId: id, ...preferences, createdAt: timestamp } },
    ...(['archive', 'trash'] as const).map((kind): PlannedEffect => ({
      kind: 'insert', collection: 'lists', id: randomUUID(),
      fields: { boardId: id, kind, name: kind === 'archive' ? 'Archive' : 'Trash', rank: null, orderVersion: 1, createdAt: timestamp },
    })),
    parent,
  ];
  const events = [invalidate(id)];
  for (const row of boards) {
    const changed = ranks.get(row.id);
    if (changed === undefined) continue;
    effects.push(rankEffect(row, changed, timestamp));
    events.push(invalidate(row.id));
  }
  return {
    effects, result: { data: { board: boardShape(board, scope.boardAccess(board, project, membership).permissions),
      projectRevision: parent.revision + 1, projectBoardOrderVersion: parent.fields.boardOrderVersion } },
    audit: audit('boards.create', id), events,
  };
}

export async function planBoardMove(
  access: BoardAccessContext, input: RelationshipCommandInput<'boards.move'>, context: CommandPlanningContext,
  scope: WorkspaceAuthorization,
): Promise<CommandPlan> {
  const { board, project, permissions } = access;
  const revision = requireRevision(board, input.expectedRevision)!;
  const version = projectBoardOrderVersion(project.project);
  if (version !== input.projectBoardOrderVersion) throw new RelationshipError('boardOrder');

  const boards = await scope.visibleBoards(project);
  const ranks = new Map(changeBoardRanks(boards, board.id, input.beforeBoardId).map((row) => [row.id, row.rank]));
  const commandAudit = audit('boards.move', board.id);
  if (!ranks.size) return {
    effects: [], result: { data: { board: boardShape(board, permissions), projectRevision: project.project.revision,
      projectBoardOrderVersion: version } }, audit: commandAudit,
  };
  if (!ranks.has(board.id)) {
    if (board.rank == null) throw new Error('The board move must assign a rank.');
    ranks.set(board.id, decodeRank(board.rank));
  }
  const parent = advanceBoardOrder(project.project, context.timestamp);
  const effects: PlannedEffect[] = [parent];
  const events: ReturnType<typeof invalidate>[] = [];
  for (const row of boards) {
    const rank = ranks.get(row.id);
    if (rank === undefined) continue;
    effects.push(rankEffect(row, rank, context.timestamp));
    events.push(invalidate(row.id));
  }
  const moved = { ...board, revision: revision + 1, updatedAt: new Date(context.timestamp), rank: encodeRank(ranks.get(board.id)!) };
  return {
    effects, result: { data: { board: boardShape(moved, permissions), projectRevision: parent.revision + 1,
      projectBoardOrderVersion: parent.fields.boardOrderVersion } }, audit: commandAudit, events,
  };
}

export async function planBoardUpdate(
  records: WorkspaceRecords, access: BoardAccessContext, input: RelationshipCommandInput<'boards.update'>, context: CommandPlanningContext,
): Promise<CommandPlan> {
  const { board, permissions } = access;
  const { id, expectedRevision, name, ...changes } = input;
  const boardEffect = touchRevision('boards', board, context.timestamp, expectedRevision);
  const { defaultView } = changes;
  const row = await boardPreferencesRow(records, context.generationId, id);
  const { revision: preferenceRevision, ...settings } = boardPreferences(board, row);
  const preferences = { ...settings, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
  let nextPreferenceRevision = preferenceRevision;
  const effects: PlannedEffect[] = [{ ...boardEffect, fields: { ...boardEffect.fields,
    ...(name === undefined ? {} : { name }), ...(defaultView === undefined ? {} : { defaultView }),
  } }];
  if (!row) {
    nextPreferenceRevision = 1;
    effects.push({ kind: 'insert', collection: 'boardPreferences', id: randomUUID(),
      fields: { boardId: id, ...preferences, createdAt: context.timestamp } });
  } else if (Object.values(changes).some((value) => value !== undefined)) {
    const revision = requireRevision(row, preferenceRevision, true);
    nextPreferenceRevision = (revision ?? 0) + 1;
    effects.push({ kind: 'update', collection: 'boardPreferences', id: row.id, revision,
      fields: { ...preferences, updatedAt: context.timestamp } });
  }
  const updated = { ...board, revision: boardEffect.revision + 1, name: name ?? board.name, updatedAt: new Date(context.timestamp) };
  return {
    effects, result: { data: { board: boardShape(updated, permissions), preferences: { ...preferences, revision: nextPreferenceRevision } } },
    audit: audit('boards.update', id), events: [invalidate(id)],
  };
}

export async function authorizeBoardDelete(database: Db, scope: WorkspaceAuthorization, input: RelationshipCommandInput<'boards.delete'>,
  origin: 'web' | 'mcp', key?: string,
) {
  requireCapability(origin === 'web');
  try {
    return await authorizeBoardManage(scope, input.id);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !key) throw error;
    const receipt = boardDeleteReceipt.safeParse(await readTerminalDeletionReceipt(database, scope, 'boards.delete', key, input));
    if (!receipt.success || receipt.data.data.id !== input.id) throw error;
    await scope.requireProject(receipt.data.data.projectId);
  }
}

export async function planBoardDelete(records: WorkspaceRecords, access: BoardAccessContext | undefined,
  input: RelationshipCommandInput<'boards.delete'>, context: CommandPlanningContext): Promise<CommandPlan> {
  if (!access) throw new WorkspaceAccessError('missing');
  const { board, project } = access;
  const revision = requireRevision(board, input.expectedRevision);
  if (board.name !== input.name) throw new RelationshipError('boardName');
  const parent = advanceBoardOrder(project.project, context.timestamp);
  const descendants = await planBoardDescendants(records, context.generationId, board.id, context.timestamp);
  return {
    effects: [...descendants.effects, { kind: 'delete', collection: 'boards', id: board.id, revision }, parent],
    result: { data: { id: board.id, projectId: project.project.id, parentRevision: parent.revision + 1 } },
    audit: audit('boards.delete', board.id), events: [
      { boardId: board.id, kind: 'board.access-changed', payload: {} }, ...descendants.otherBoardIds.map(invalidate),
    ],
  };
}
