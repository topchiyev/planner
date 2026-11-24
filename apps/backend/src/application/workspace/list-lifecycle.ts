import { randomUUID } from 'node:crypto';
import { finiteListKindSchema, type RelationshipCommandInput } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank, encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext } from '../command-journal/operation.js';
import { requireCapability, type BoardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { boardListOrderVersion, listCardOrderVersion, listDto } from './list-state.js';
import { planRankChange, RankAnchorError } from './ordered-ranks.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, rankSort, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type ListAccess = Awaited<ReturnType<WorkspaceAuthorization['requireList']>>;

export async function authorizeListCreate(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireBoard(id);
  requireCapability(access.permissions.canEdit);
  return access;
}

export async function authorizeListEdit(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireList(id);
  requireCapability(access.board.permissions.canEdit && finiteListKindSchema.safeParse(access.list.kind).success);
  return access;
}

export async function authorizeListMove(scope: WorkspaceAuthorization, input: RelationshipCommandInput<'lists.move'>) {
  const access = await authorizeListEdit(scope, input.id);
  if (input.toBoardId !== access.board.board.id) throw new RelationshipError('listOrder');
  return access;
}

function boardEffect(board: WorkspaceRow<'boards'>, timestamp: string, orderVersion: number, expected = board.revision) {
  const touch = touchRevision('boards', board, timestamp, expected);
  const next = revisionSchema.safeParse(orderVersion);
  if (!next.success) throw new RelationshipError('listOrder');
  return { ...touch, fields: { ...touch.fields, orderVersion: next.data } };
}

async function finiteLists(records: WorkspaceRecords, generationId: string, boardId: string) {
  const kinds = finiteListKindSchema.options;
  return records.find('lists', { boardId, kind: { $in: kinds },
    $expr: { $and: [canonicalRow(generationId), equal('boardId', boardId), { $in: ['$kind', kinds] }] } }, rankSort);
}

function listRanks(rows: WorkspaceRow<'lists'>[], id: string, before: string | null) {
  try {
    return new Map(planRankChange(rows.map((row) => ({ id: row.id, rank: row.rank == null ? null : decodeRank(row.rank) })),
      id, before).map(({ id: changedId, rank }) => [changedId, rank]));
  } catch (error) {
    if (error instanceof RankAnchorError) throw new RelationshipError('listOrder');
    throw error;
  }
}

function listEffect(list: WorkspaceRow<'lists'>, timestamp: string, changes: { rank?: string; name?: string; color?: WorkspaceRow<'lists'>['color'] }) {
  const base = touchRevision('lists', list, timestamp);
  return { ...base, fields: { ...base.fields, orderVersion: listCardOrderVersion(list), ...changes } };
}

function result(list: Parameters<typeof listDto>[0], boardRevision: number, boardOrderVersion: number) {
  return { data: { list: listDto(list), boardRevision, boardOrderVersion } };
}

const audit = (action: string, resourceId: string) => ({ action, resourceId, resourceType: 'list' });
const invalidation = (boardId: string) => ({ boardId, kind: 'board.invalidated', payload: {} });

export async function planListCreate(records: WorkspaceRecords, { board }: BoardAccessContext,
  input: RelationshipCommandInput<'lists.create'>, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const parent = boardEffect(board, timestamp, boardListOrderVersion(board) + 1, input.expectedRevision);
  const id = randomUUID();
  const lists = await finiteLists(records, generationId, board.id);
  const ranks = listRanks(lists, id, null);
  const rank = ranks.get(id);
  if (rank === undefined) throw new Error('The finite list append requires a rank.');
  const fields = { boardId: board.id, name: input.name, color: input.color, kind: input.kind, orderVersion: 1 };
  return {
    effects: [
      { kind: 'insert', collection: 'lists', id, fields: { ...fields, rank: rank.toString(), createdAt: timestamp, updatedAt: null } },
      ...lists.flatMap((list) => {
        const changed = ranks.get(list.id);
        return changed === undefined ? [] : [listEffect(list, timestamp, { rank: changed.toString() })];
      }),
      parent,
    ],
    result: result({ ...fields, id, revision: 1, rank: encodeRank(rank), createdAt: new Date(timestamp) },
      parent.revision + 1, parent.fields.orderVersion),
    audit: audit('lists.create', id), events: [invalidation(board.id)],
  };
}

export async function planListUpdate(_records: WorkspaceRecords, { list, board: { board } }: ListAccess,
  input: RelationshipCommandInput<'lists.update'>, { timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  requireRevision(list, input.expectedRevision);
  const orderVersion = boardListOrderVersion(board);
  const parent = boardEffect(board, timestamp, orderVersion);
  const fields = { ...(input.name !== undefined && { name: input.name }), ...(input.color !== undefined && { color: input.color }) };
  const changed = listEffect(list, timestamp, fields);
  return {
    effects: [changed, parent],
    result: result({ ...list, ...fields, revision: changed.revision + 1, orderVersion: changed.fields.orderVersion, updatedAt: new Date(timestamp) },
      parent.revision + 1, orderVersion),
    audit: audit('lists.update', list.id), events: [invalidation(board.id)],
  };
}

export async function planListMove(records: WorkspaceRecords, { list, board: { board } }: ListAccess,
  input: RelationshipCommandInput<'lists.move'>, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const { beforeListId, sourceOrderVersion, destinationOrderVersion } = input;
  const orderVersion = boardListOrderVersion(board);
  requireRevision(list, input.expectedRevision);
  if (sourceOrderVersion !== orderVersion || destinationOrderVersion !== orderVersion) {
    throw new RelationshipError('listOrder');
  }
  if (beforeListId === list.id) throw new RelationshipError('listAnchor');
  const lists = await finiteLists(records, generationId, board.id);
  const ranks = listRanks(lists, list.id, beforeListId);
  const commandAudit = audit('lists.move', list.id);
  if (!ranks.size) return { effects: [], result: result(list, board.revision, orderVersion), audit: commandAudit };
  const parent = boardEffect(board, timestamp, orderVersion + 1);
  const moved = listEffect(list, timestamp, {});
  const rank = ranks.get(list.id);
  if (rank !== undefined) moved.fields = { ...moved.fields, rank: rank.toString() };
  return {
    effects: [moved, ...lists.flatMap((row) => {
      const changed = ranks.get(row.id);
      return row.id === list.id || changed === undefined ? [] : [listEffect(row, timestamp, { rank: changed.toString() })];
    }), parent],
    result: result({ ...list, rank: rank === undefined ? list.rank : encodeRank(rank), revision: moved.revision + 1,
      orderVersion: moved.fields.orderVersion, updatedAt: new Date(timestamp) }, parent.revision + 1, parent.fields.orderVersion),
    audit: commandAudit, events: [invalidation(board.id)],
  };
}
