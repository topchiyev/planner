import { randomUUID } from 'node:crypto';
import { finiteListKindSchema, type RelationshipCommandInput } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank, encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { cardsInPlacement, previousPlacementProvenance, scopedBoardInvalidation } from './card-history.js';
import { cardClosed } from './card-state.js';
import { nextFieldOrder } from './field-planning.js';
import { fieldGroupOrder } from './field-state.js';
import { mergeTransferEffects, planMoveCardGraph } from './transfer-graph.js';
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
  const source = await authorizeListEdit(scope, input.id);
  if (input.toBoardId === source.board.board.id) return { source, destination: source.board };
  let destination: BoardAccessContext;
  try {
    destination = await scope.requireBoard(input.toBoardId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.statusCode === 404) throw new RelationshipError('listOrder');
    throw error;
  }
  if (!destination.permissions.canEdit) throw new RelationshipError('listOrder');
  return { source, destination };
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

function listEffect(list: WorkspaceRow<'lists'>, timestamp: string, changes: { boardId?: string; rank?: string; name?: string; color?: WorkspaceRow<'lists'>['color'] }) {
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

export async function planListMove(records: WorkspaceRecords, { source, destination }: Awaited<ReturnType<typeof authorizeListMove>>,
  input: RelationshipCommandInput<'lists.move'>, context: CommandPlanningContext): Promise<CommandPlan> {
  const { list, board: { board } } = source;
  const { generationId, timestamp, actorId, commandId } = context;
  const { beforeListId, sourceOrderVersion, destinationOrderVersion } = input;
  const oldVersion = boardListOrderVersion(board);
  const nextVersion = boardListOrderVersion(destination.board);
  requireRevision(list, input.expectedRevision);
  if (sourceOrderVersion !== oldVersion || destinationOrderVersion !== nextVersion) throw new RelationshipError('listOrder');
  if (beforeListId === list.id) throw new RelationshipError('listAnchor');
  const same = board.id === destination.board.id;
  const lists = await finiteLists(records, generationId, destination.board.id);
  const ranks = listRanks(lists, list.id, beforeListId);
  const commandAudit = audit('lists.move', list.id);
  if (!ranks.size) return { effects: [], result: result(list, board.revision, oldVersion), audit: commandAudit };
  const parent = boardEffect(destination.board, timestamp, nextVersion + 1);
  const moved = listEffect(list, timestamp, same ? {} : { boardId: destination.board.id });
  const rank = ranks.get(list.id);
  if (rank !== undefined) moved.fields = { ...moved.fields, rank: rank.toString() };
  const resultingList = { ...list, boardId: destination.board.id, rank: rank === undefined ? list.rank : encodeRank(rank),
    revision: moved.revision + 1, orderVersion: moved.fields.orderVersion, updatedAt: new Date(timestamp) };
  const effects: PlannedEffect[] = [moved, ...lists.flatMap((row) => {
    const changed = ranks.get(row.id);
    return row.id === list.id || changed === undefined ? [] : [listEffect(row, timestamp, { rank: changed.toString() })];
  }), parent];
  const receipt = result(resultingList, parent.revision + 1, parent.fields.orderVersion);
  if (same) return { effects, result: receipt, audit: commandAudit, events: [invalidation(board.id)] };

  const original = boardEffect(board, timestamp, oldVersion + 1);
  const occupants = await cardsInPlacement(records, generationId, list, 'board');
  const graph = await planMoveCardGraph(records, board, destination.board,
    occupants.map((card) => ({ card, completed: cardClosed(card, list) })), context);
  effects.push(original, ...graph.effects);
  for (const card of occupants) {
    const touch = touchRevision('cards', card, timestamp);
    effects.push({ ...touch, fields: {
      ...touch.fields, boardId: destination.board.id, previousListId: null,
      ...previousPlacementProvenance(card.previousListId, timestamp, 'removed'),
      ...(graph.fieldOrderChanged.has(card.id) && { fieldGroupOrderVersion: nextFieldOrder(fieldGroupOrder(card)) }),
    } });
  }
  effects.push({ kind: 'insert', collection: 'activities', id: randomUUID(), fields: {
    boardId: destination.board.id, actorId, commandId, listId: list.id, kind: 'moveList', createdAt: timestamp,
  } });
  graph.invalidated.add(board.id).add(destination.board.id);
  return {
    effects: mergeTransferEffects(effects),
    result: { data: { ...receipt.data, sourceBoardRevision: original.revision + 1,
      sourceBoardOrderVersion: original.fields.orderVersion, remaps: graph.summary } },
    audit: { ...commandAudit, detail: graph.summary },
    events: [...occupants.map((card) => ({ boardId: board.id, kind: 'card.removed', payload: { id: card.id } })),
      ...[...graph.invalidated].sort().map(scopedBoardInvalidation)],
  };
}
