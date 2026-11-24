import type { CardPlacementVersions, CardTransition, RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { cardContextForList, requireCapability, WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import {
  boardHistoryChange, cardMovementActivity, cardsInPlacement, finiteList, historyArrival, listPlacementChange, previousFiniteList,
  previousPlacementProvenance, reserveCardHistory, scopedBoardInvalidation, scopedSystemList,
} from './card-history.js';
import { singleCardMoveNotifications } from './card-move-notifications.js';
import { cardClosed } from './card-state.js';
import { planLinkedCardCompletion } from './linked-card-completion.js';
import { listCardOrderVersion } from './list-state.js';
import { planRankChange, RankAnchorError } from './ordered-ranks.js';
import { CardPlacementConflict, RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';

type Request = { [K in CardTransition]: { operation: K; input: RelationshipCommandInput<K> } }[CardTransition];
type List = WorkspaceRow<'lists'>;
type Access = { source: CardAccessContext; explicitDestination: List | null };
type Update = Extract<PlannedEffect, { kind: 'update' }>;
type Position = CardPlacementVersions['source'];

export async function authorizeCardTransition(scope: WorkspaceAuthorization, input: Request['input']): Promise<Access> {
  const source = await scope.requireCard(input.id);
  requireCapability(source.board.permissions.canEdit);
  if (!('toListId' in input) || input.toListId === null) return { source, explicitDestination: null };

  let destination: List;
  try {
    destination = (await scope.requireList(input.toListId, source.board.board.id)).list;
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.statusCode === 404) throw new RelationshipError('cardOrder');
    throw error;
  }
  if (!finiteList(destination)) throw new RelationshipError('cardTransition');
  return { source, explicitDestination: destination };
}

async function resolveDestination(records: WorkspaceRecords, generationId: string, access: Access, { operation }: Request) {
  const { card, list, board } = access.source;
  if (operation === 'cards.move') return access.explicitDestination!;
  if (operation === 'cards.restore') {
    if (finiteList(list)) throw new RelationshipError('cardTransition');
    const destination = access.explicitDestination ?? await previousFiniteList(records, card);
    if (!destination) throw new RelationshipError('restoreTarget');
    return destination;
  }
  const kind = operation === 'cards.archive' ? 'archive' : 'trash';
  if ((kind === 'archive' && !finiteList(list)) || (kind === 'trash' && list.kind === 'trash')) {
    throw new RelationshipError('cardTransition');
  }
  return scopedSystemList(records, generationId, board.board.id, kind);
}

function listPosition(list: List, change?: ReturnType<typeof listPlacementChange>): Position {
  return { listId: list.id, revision: list.revision + Number(!!change),
    orderVersion: change?.fields.orderVersion ?? listCardOrderVersion(list) };
}

function addCardUpdate(updates: Map<string, Update>, update: Update) {
  const key = update.collection + '/' + update.id;
  const previous = updates.get(key);
  if (!previous) updates.set(key, update);
  else {
    if (previous.revision !== update.revision) throw new Error('Conflicting revisions in a card transition.');
    updates.set(key, { ...previous, fields: { ...previous.fields, ...update.fields } });
  }
}

export async function planCardTransition(database: Db, records: WorkspaceRecords, access: Access,
  request: Request, context: CommandPlanningContext): Promise<CommandPlan> {
  const { card, list: source, board: { board } } = access.source;
  const { generationId, timestamp } = context;
  const { operation, input } = request;
  const destination = await resolveDestination(records, generationId, access, request);
  const current = { cardRevision: card.revision, source: listPosition(source), destination: listPosition(destination) };
  let revision: number;
  try {
    revision = requireRevision(card, input.expectedRevision, true)!;
  } catch (error) {
    if (error instanceof RelationshipError && error.code === 'REVISION_CONFLICT') throw new CardPlacementConflict('cardRevision', current);
    throw error;
  }
  if (input.sourceOrderVersion !== current.source.orderVersion || input.destinationOrderVersion !== current.destination.orderVersion) {
    throw new CardPlacementConflict('cardOrder', current);
  }

  const same = source.id === destination.id;
  const closedBefore = cardClosed(card, source);
  const kind = cardContextForList(destination);
  const closed = same || kind !== 'board' ? closedBefore : destination.kind === 'closed';
  const audit = { action: operation, resourceType: 'card', resourceId: card.id };
  const makeResult = (nextRevision: number, prev: Position, next: Position) => ({ data: {
    card: { id: card.id, boardId: board.id, listId: destination.id, kind, closed, revision: nextRevision }, source: prev, destination: next,
  } });
  const effects: PlannedEffect[] = [];
  const updates = new Map<string, Update>();
  let fields: JournalFields;

  if (kind === 'board') {
    const occupants = await cardsInPlacement(records, generationId, destination, kind);
    let ranks: ReturnType<typeof planRankChange>;
    try {
      ranks = planRankChange(occupants.map((row) => ({ id: row.id, rank: row.rank == null ? null : decodeRank(row.rank) })),
        card.id, 'beforeCardId' in input ? input.beforeCardId : null);
    } catch (error) {
      if (error instanceof RankAnchorError) throw new RelationshipError('cardOrder');
      throw error;
    }
    if (same && !ranks.length) return {
      effects: [], result: makeResult(revision, listPosition(source), listPosition(destination)), audit,
    };
    const byId = new Map(occupants.map((row) => [row.id, row]));
    let rank = card.rank == null ? null : decodeRank(card.rank);
    for (const changed of ranks) {
      if (changed.id === card.id) rank = changed.rank;
      else {
        const sibling = touchRevision('cards', byId.get(changed.id)!, timestamp);
        addCardUpdate(updates, { ...sibling, fields: { ...sibling.fields, rank: changed.rank.toString() } });
      }
    }
    if (rank === null) throw new Error('A finite card placement requires a rank.');
    fields = {
      rank: rank.toString(),
      ...(!same && { listId: destination.id, kind, closed, listChangedAt: timestamp }),
      ...(!finiteList(source) && {
        previousListId: null, ...previousPlacementProvenance(card.previousListId, timestamp, 'restored'),
      }),
    };
  } else {
    const history = (await reserveCardHistory(records, generationId, board, 1))!;
    const prior = finiteList(source) ? source : await previousFiniteList(records, card);
    fields = historyArrival(card, source, destination, kind, history.first, prior?.id ?? null, timestamp);
    effects.push(boardHistoryChange(board, timestamp, history.last));
  }

  const changedRankSiblings = updates.size > 0;
  const cardChange = touchRevision('cards', card, timestamp, revision);
  addCardUpdate(updates, { ...cardChange, fields: { ...cardChange.fields, ...fields } });
  const sourceChange = listPlacementChange(source, timestamp);
  const destinationChange = same ? sourceChange : listPlacementChange(destination, timestamp);
  const activity = cardMovementActivity(card, source, destination, context);
  effects.push(sourceChange, ...(!same ? [destinationChange] : []), activity);
  if (operation === 'cards.move') effects.push(...await singleCardMoveNotifications(database, records, card, activity.id, context));

  const links = closed === closedBefore ? null : await planLinkedCardCompletion(records, generationId, { id: card.id, boardId: board.id }, closed, timestamp);
  for (const effect of links?.effects ?? []) {
    if (effect.kind !== 'update') throw new Error('Linked completion must only update scoped rows.');
    addCardUpdate(updates, effect);
  }
  const invalidated = new Set(links?.events.map(({ boardId }) => boardId));
  if (changedRankSiblings) invalidated.add(board.id);
  const resultRevision = cardChange.revision + 1;
  return {
    effects: [...updates.values(), ...effects],
    result: makeResult(resultRevision, listPosition(source, sourceChange), listPosition(destination, destinationChange)), audit,
    events: [{ boardId: board.id, kind: 'card.changed', payload: { id: card.id, revision: resultRevision } },
      ...[...invalidated].sort().map(scopedBoardInvalidation)],
  };
}
