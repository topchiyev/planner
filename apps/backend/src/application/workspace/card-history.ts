import { randomUUID } from 'node:crypto';
import { finiteListKindSchema } from '@planner/contracts';
import { maximumSignedInt64, publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { cardClosed } from './card-state.js';
import { boardListOrderVersion, listCardOrderVersion } from './list-state.js';
import { RelationshipError, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, rankSort, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Board = WorkspaceRow<'boards'>;
type List = WorkspaceRow<'lists'>;
type Card = WorkspaceRow<'cards'>;
export type HistoryKind = 'archive' | 'trash';

export const finiteList = (list: List) => finiteListKindSchema.safeParse(list.kind).success;

export async function scopedSystemList(records: WorkspaceRecords, generationId: string, boardId: string, kind: HistoryKind) {
  const list = await records.first('lists', { boardId, kind,
    $expr: { $and: [canonicalRow(generationId), equal('boardId', boardId), equal('kind', kind)] } });
  if (!list || list.rank !== null) throw new RelationshipError('cardOrder');
  return list;
}

export async function cardHistoryHighWater(records: WorkspaceRecords, generationId: string, board: Board) {
  let previous: bigint;
  if (board.historySequence !== undefined) previous = decodeRank(board.historySequence);
  else {
    const latest = await records.first('cards', { boardId: board.id, historySequence: { $type: 'long' },
      $expr: { $and: [canonicalRow(generationId), equal('boardId', board.id),
        { $eq: [{ $type: '$historySequence' }, 'long'] }] } }, { historySequence: -1 });
    previous = latest?.historySequence === undefined ? 0n : decodeRank(latest.historySequence);
  }
  return previous < 0n ? 0n : previous;
}

export async function reserveCardHistory(records: WorkspaceRecords, generationId: string, board: Board, count: number) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Expected an exact history arrival count.');
  if (count === 0) return null;
  const previous = await cardHistoryHighWater(records, generationId, board);
  const last = previous + BigInt(count);
  if (last > maximumSignedInt64) throw new RelationshipError('cardOrder');
  return { first: previous + 1n, last };
}

export function boardHistoryChange(board: Board, timestamp: string, last?: bigint, removeList = false) {
  const parent = touchRevision('boards', board, timestamp);
  const orderVersion = revisionSchema.safeParse(boardListOrderVersion(board) + Number(removeList));
  if (!orderVersion.success) throw new RelationshipError('listOrder');
  return { ...parent, fields: { ...parent.fields, orderVersion: orderVersion.data,
    ...(last !== undefined && { historySequence: last.toString() }) } };
}

export function cardsInPlacement(records: WorkspaceRecords, generationId: string, list: List, kind: Card['kind']) {
  const { id: listId, boardId } = list;
  return records.find('cards', { listId, boardId, kind,
    $expr: { $and: [canonicalRow(generationId), equal('listId', listId), equal('boardId', boardId), equal('kind', kind)] } }, rankSort);
}

export function listPlacementChange(list: List, timestamp: string) {
  const base = touchRevision('lists', list, timestamp);
  const next = revisionSchema.safeParse(listCardOrderVersion(list) + 1);
  if (!next.success) throw new RelationshipError('cardOrder');
  return { ...base, fields: { ...base.fields, orderVersion: next.data } };
}

export async function previousFiniteList(records: WorkspaceRecords, card: Card) {
  if (!publicIdSchema.safeParse(card.previousListId).success) return null;
  const list = await records.get('lists', card.previousListId!);
  return list && list.boardId === card.boardId && finiteList(list) ? list : null;
}

export function previousPlacementProvenance(id: string | null | undefined, timestamp: string, reason: 'restored' | 'removed'): JournalFields {
  return publicIdSchema.safeParse(id).success ? { previousListProvenance: { listId: id!, at: timestamp, reason } } : {};
}

export function historyArrival(card: Card, source: List, destination: List, kind: HistoryKind, sequence: bigint,
  previousListId: string | null, timestamp: string): JournalFields {
  return {
    listId: destination.id, kind, rank: null, closed: cardClosed(card, source), listChangedAt: timestamp,
    historySequence: sequence.toString(), previousListId, updatedAt: timestamp,
    ...(previousListId === null && previousPlacementProvenance(finiteList(source) ? source.id : card.previousListId, timestamp, 'removed')),
  };
}

export function cardMovementActivity(card: Card, source: List, destination: List, context: CommandPlanningContext): PlannedEffect & { kind: 'insert' } {
  return {
    kind: 'insert', collection: 'activities', id: randomUUID(),
    fields: { boardId: card.boardId, cardId: card.id, actorId: context.actorId, commandId: context.commandId,
      kind: 'moveCard', fromListId: source.id, toListId: destination.id, createdAt: context.timestamp },
  };
}

export const scopedBoardInvalidation = (boardId: string) => ({ boardId, kind: 'board.invalidated', payload: {} });
