import type { RelationshipCommandInput } from '@planner/contracts';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, type BoardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { planCardDescendants } from './card-deletion.js';
import {
  boardHistoryChange, cardHistoryHighWater, cardMovementActivity, cardsInPlacement, historyArrival, listPlacementChange,
  reserveCardHistory, scopedBoardInvalidation, scopedSystemList,
} from './card-history.js';
import { planSortedCardRanks } from './list-sort.js';
import { listCardOrderVersion } from './list-state.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';

type List = WorkspaceRow<'lists'>;
type ListAccess = Awaited<ReturnType<WorkspaceAuthorization['requireList']>>;

const position = (list: List, change?: ReturnType<typeof listPlacementChange>) => ({
  listId: list.id, revision: list.revision + Number(!!change),
  orderVersion: change?.fields.orderVersion ?? listCardOrderVersion(list),
});

function matchPlacement(list: List, version: number, revision?: number) {
  if (revision !== undefined) requireRevision(list, revision);
  if (listCardOrderVersion(list) !== version) throw new RelationshipError('cardOrder');
}

export async function planListSort(records: WorkspaceRecords, { list }: ListAccess,
  input: RelationshipCommandInput<'lists.sort'>, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  matchPlacement(list, input.sourceOrderVersion, input.expectedRevision);
  const cards = await cardsInPlacement(records, generationId, list, 'board');
  const ranks = planSortedCardRanks(cards, input);
  const audit = { action: 'lists.sort', resourceType: 'list', resourceId: list.id };
  if (!ranks.length) return { effects: [], result: { data: { source: position(list), changedCount: 0 } }, audit };

  const source = listPlacementChange(list, timestamp);
  const effects = ranks.map(({ card, rank }) => {
    const effect = touchRevision('cards', card, timestamp);
    return { ...effect, fields: { ...effect.fields, rank: rank.toString() } };
  });
  return { effects: [...effects, source], result: { data: { source: position(list, source), changedCount: ranks.length } },
    audit, events: [scopedBoardInvalidation(list.boardId)] };
}

export async function planArchiveCards(records: WorkspaceRecords, { list, board: { board } }: ListAccess,
  input: RelationshipCommandInput<'lists.archiveCards'>, context: CommandPlanningContext): Promise<CommandPlan> {
  const { generationId, timestamp } = context;
  matchPlacement(list, input.sourceOrderVersion, input.expectedRevision);
  if (list.kind !== 'closed') throw new RelationshipError('archiveCardsSource');
  const archive = await scopedSystemList(records, generationId, board.id, 'archive');
  if (archive.id !== input.archiveListId) throw new RelationshipError('cardOrder');
  matchPlacement(archive, input.destinationOrderVersion);

  const cards = await cardsInPlacement(records, generationId, list, 'board');
  const audit = { action: 'lists.archiveCards', resourceType: 'list', resourceId: list.id };
  const history = await reserveCardHistory(records, generationId, board, cards.length);
  if (!history) return { effects: [], result: { data: { source: position(list), destination: position(archive), archivedCount: 0 } }, audit };

  const source = listPlacementChange(list, timestamp);
  const destination = listPlacementChange(archive, timestamp);
  const effects: PlannedEffect[] = [];
  for (const [index, card] of cards.entries()) {
    // All arrivals share a timestamp. The history view orders their reserved sequences descending.
    const arrival = touchRevision('cards', card, timestamp);
    effects.push({ ...arrival, fields: historyArrival(card, list, archive, 'archive', history.last - BigInt(index), list.id, timestamp) });
    effects.push(cardMovementActivity(card, list, archive, context));
  }
  return {
    effects: [...effects, source, destination, boardHistoryChange(board, timestamp, history.last)],
    result: { data: { source: position(list, source), destination: position(archive, destination), archivedCount: cards.length } },
    audit, events: [scopedBoardInvalidation(board.id)],
  };
}

export async function authorizeClearTrash(scope: WorkspaceAuthorization, id: string, origin: 'web' | 'mcp') {
  requireCapability(origin === 'web');
  const board = await scope.requireBoard(id);
  requireCapability(board.permissions.canClearTrash);
  return board;
}

export async function planClearTrash(records: WorkspaceRecords, { board }: BoardAccessContext,
  input: RelationshipCommandInput<'lists.clearTrash'>, context: CommandPlanningContext): Promise<CommandPlan> {
  const { generationId, timestamp } = context;
  const trash = await scopedSystemList(records, generationId, board.id, 'trash');
  if (trash.id !== input.trashListId) throw new RelationshipError('cardOrder');
  matchPlacement(trash, input.trashOrderVersion, input.expectedRevision);
  const cards = await cardsInPlacement(records, generationId, trash, 'trash');
  const audit = { action: 'lists.clearTrash', resourceType: 'list', resourceId: trash.id };
  if (!cards.length) return { effects: [], result: { data: { trash: position(trash), clearedCount: 0 } }, audit };

  const change = listPlacementChange(trash, timestamp);
  const descendants = await planCardDescendants(records, cards, [trash], context);
  if (board.historySequence === undefined) {
    // An earlier installation may only record its history counter on cards that this plan removes.
    const highWater = await cardHistoryHighWater(records, generationId, board);
    descendants.effects.push(boardHistoryChange(board, timestamp, highWater));
  }
  const touched = [board.id, ...descendants.otherBoardIds.filter((id) => id !== board.id)];
  return {
    effects: [...descendants.effects, change], result: { data: { trash: position(trash, change), clearedCount: cards.length } },
    audit, events: touched.map(scopedBoardInvalidation),
  };
}
