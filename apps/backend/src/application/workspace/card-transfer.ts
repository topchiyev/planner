import { randomUUID } from 'node:crypto';
import type { CardPlacementVersions, RelationshipCommandInput } from '@planner/contracts';
import { encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { cardContextForList, requireCapability, WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { boardPreferences, boardPreferencesRow } from './board-state.js';
import {
  boardHistoryChange, finiteList, historyArrival, listPlacementChange, previousPlacementProvenance, reserveCardHistory, scopedBoardInvalidation,
} from './card-history.js';
import { planNewCardPlacement, readCardType } from './card-lifecycle.js';
import { cardClosed, cardDto, cardDue, cardStopwatch } from './card-state.js';
import { nextFieldOrder } from './field-planning.js';
import { fieldGroupOrder } from './field-state.js';
import { listCardOrderVersion } from './list-state.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';
import { CardPlacementConflict, RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import { mergeTransferEffects, planDuplicateCardGraph, planMoveCardGraph } from './transfer-graph.js';

type List = WorkspaceRow<'lists'>;
type ListAccess = Awaited<ReturnType<WorkspaceAuthorization['requireList']>>;
type CardTransfer = RelationshipCommandInput<'cards.move' | 'cards.duplicate'>;
export type CardTransferAccess = { source: CardAccessContext; destination: ListAccess };

export async function authorizeCardTransfer(scope: WorkspaceAuthorization, input: CardTransfer, duplicate = false): Promise<CardTransferAccess> {
  const source = await scope.requireCard(input.id);
  requireCapability(duplicate ? source.permissions.canDuplicateFrom : source.permissions.canMove);
  let destination: ListAccess;
  try {
    destination = await scope.requireList(input.toListId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.statusCode === 404) throw new RelationshipError('cardOrder');
    throw error;
  }
  if (!destination.board.permissions.canEdit || (input.destinationBoardId !== undefined && input.destinationBoardId !== destination.board.board.id)) {
    throw new RelationshipError('cardOrder');
  }
  if (!finiteList(destination.list) && (duplicate || destination.list.rank !== null || input.beforeCardId !== null)) {
    throw new RelationshipError('cardTransition');
  }
  return { source, destination };
}

const position = (list: List, next?: ReturnType<typeof listPlacementChange>): CardPlacementVersions['source'] => ({
  listId: list.id, revision: list.revision + Number(!!next),
  orderVersion: next?.fields.orderVersion ?? listCardOrderVersion(list),
});

function checkVersions({ source: { card, list }, destination }: CardTransferAccess, input: CardTransfer, write: boolean) {
  const current = { cardRevision: card.revision, source: position(list), destination: position(destination.list) };
  let revision: number;
  try {
    revision = requireRevision(card, input.expectedRevision, write)!;
  } catch (error) {
    if (error instanceof RelationshipError && error.code === 'REVISION_CONFLICT') throw new CardPlacementConflict('cardRevision', current);
    throw error;
  }
  if (input.sourceOrderVersion !== current.source.orderVersion || input.destinationOrderVersion !== current.destination.orderVersion) {
    throw new CardPlacementConflict('cardOrder', current);
  }
  return revision;
}

export async function planCrossBoardCardMove(records: WorkspaceRecords, access: CardTransferAccess,
  input: RelationshipCommandInput<'cards.move'>, context: CommandPlanningContext): Promise<CommandPlan> {
  const { card, list: source, board: { board: sourceBoard } } = access.source;
  const { list: destination, board: { board: destinationBoard } } = access.destination;
  const { generationId, timestamp, actorId, commandId } = context;
  const revision = checkVersions(access, input, true);
  const kind = cardContextForList(destination);
  const closed = kind === 'board' ? destination.kind === 'closed' : cardClosed(card, source);
  const effects: PlannedEffect[] = [];
  let fields: JournalFields;
  if (kind === 'board') {
    const placement = await planNewCardPlacement(records, generationId, destinationBoard.id, destination.id,
      card.id, input.beforeCardId, timestamp);
    fields = { listId: destination.id, kind, closed, listChangedAt: timestamp, rank: placement.rank.toString(), previousListId: null,
      ...previousPlacementProvenance(card.previousListId, timestamp, 'restored') };
    effects.push(...placement.effects);
  } else {
    const history = (await reserveCardHistory(records, generationId, destinationBoard, 1))!;
    fields = historyArrival(card, source, destination, kind, history.first, null, timestamp);
    effects.push(boardHistoryChange(destinationBoard, timestamp, history.last));
  }
  const graph = await planMoveCardGraph(records, sourceBoard, destinationBoard, [{ card, completed: closed }], context);
  if (kind === 'board' && graph.summary.labelsCreated > 0) effects.push(boardHistoryChange(destinationBoard, timestamp));
  const sourceChange = listPlacementChange(source, timestamp);
  const destinationChange = listPlacementChange(destination, timestamp);
  const cardChange = touchRevision('cards', card, timestamp, revision);
  graph.invalidated.add(destinationBoard.id);
  return {
    effects: mergeTransferEffects([...effects, ...graph.effects, sourceChange, destinationChange,
      { ...cardChange, fields: { ...cardChange.fields, ...fields, boardId: destinationBoard.id, transferredAcrossBoards: true,
        ...(graph.fieldOrderChanged.has(card.id) && { fieldGroupOrderVersion: nextFieldOrder(fieldGroupOrder(card)) }) } },
      { kind: 'insert', collection: 'activities', id: randomUUID(), fields: {
        boardId: destinationBoard.id, cardId: card.id, actorId, commandId, kind: 'moveCard', toListId: destination.id, createdAt: timestamp,
      } },
    ]),
    result: { data: {
      card: { id: card.id, boardId: destinationBoard.id, listId: destination.id, kind, closed, revision: revision + 1 },
      source: position(source, sourceChange), destination: position(destination, destinationChange), remaps: graph.summary,
    } },
    audit: { action: 'cards.move', resourceType: 'card', resourceId: card.id, detail: graph.summary },
    events: [{ boardId: sourceBoard.id, kind: 'card.removed', payload: { id: card.id } },
      { boardId: destinationBoard.id, kind: 'card.changed', payload: { id: card.id, revision: revision + 1 } },
      ...[...graph.invalidated].sort().map(scopedBoardInvalidation)],
  };
}

export async function planDuplicateCard(records: WorkspaceRecords, access: CardTransferAccess,
  input: RelationshipCommandInput<'cards.duplicate'>, context: CommandPlanningContext, scope: WorkspaceAuthorization): Promise<CommandPlan> {
  const { card, board: { board: sourceBoard } } = access.source;
  const { list, board } = access.destination;
  const { generationId, timestamp, actorId, commandId } = context;
  checkVersions(access, input, false);
  const id = randomUUID();
  const options = boardPreferences(board.board, await boardPreferencesRow(records, generationId, board.board.id));
  const type = readCardType(card.type, options);
  const { rank, effects: placement } = await planNewCardPlacement(records, generationId, board.board.id, list.id,
    id, input.beforeCardId, timestamp);
  const graph = await planDuplicateCardGraph(records, sourceBoard, board.board, card, id, scope, context);
  const destination = listPlacementChange(list, timestamp);
  const fields = { boardId: board.board.id, listId: list.id, type, kind: 'board' as const, closed: list.kind === 'closed',
    name: card.name, ...cardDue(card) };
  const stopwatch = cardStopwatch(card.stopwatch);
  const elapsed = stopwatch?.startedAt ? Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(stopwatch.startedAt)) / 1000)) : 0;
  const total = (stopwatch?.total ?? 0) + elapsed;
  if (!Number.isSafeInteger(total)) throw new RelationshipError('cardStopwatch');
  const created = new Date(timestamp);
  const duplicate = cardDto({ ...fields, id, rank: encodeRank(rank), revision: 1, createdAt: created }, board, list);
  return {
    effects: [{ kind: 'insert', collection: 'cards', id, fields: {
      ...fields, creatorId: actorId, description: card.description ?? null, rank: rank.toString(), createdAt: timestamp, updatedAt: null,
      stopwatch: stopwatch ? { total, startedAt: null } : null,
      previousListId: null, coverAttachmentId: graph.coverAttachmentId, checklistOrderVersion: 1, fieldGroupOrderVersion: 1,
    } }, ...graph.effects, ...placement, destination, ...(graph.summary.labelsCreated > 0 ? [boardHistoryChange(board.board, timestamp)] : []),
    { kind: 'insert', collection: 'activities', id: randomUUID(), fields: {
      boardId: board.board.id, cardId: id, actorId, commandId, kind: 'duplicateCard', createdAt: timestamp,
    } }],
    result: { data: { card: duplicate, destination: position(list, destination), remaps: graph.summary } },
    audit: { action: 'cards.duplicate', resourceType: 'card', resourceId: id, detail: graph.summary },
    events: [{ boardId: board.board.id, kind: 'card.changed', payload: { id, revision: 1 } }, scopedBoardInvalidation(board.board.id)],
  };
}
