import { cardStopwatchSchema } from '@planner/contracts';
import { decodeRank, isStoredDate, readStoredInstant } from '../../storage/identity.js';
import { cardPermissions, type BoardAccessContext } from './authorization.js';
import type { WorkspaceRow } from './records.js';

export function cardClosed(card: Pick<WorkspaceRow<'cards'>, 'closed'>, list: Pick<WorkspaceRow<'lists'>, 'kind'>) {
  return card.closed ?? list.kind === 'closed';
}

export function cardDue(card: Pick<WorkspaceRow<'cards'>, 'dueDate' | 'dueDateCompleted' | 'isDueCompleted'>) {
  const dueDate = readStoredInstant(card.dueDate ?? null, 'dueDate')?.toISOString() ?? null;
  return { dueDate, dueDateCompleted: dueDate === null ? null : (card.dueDateCompleted ?? card.isDueCompleted) === true };
}

export function cardStopwatch(value: unknown) {
  if (value && typeof value === 'object' && 'startedAt' in value && isStoredDate(value.startedAt)) {
    value = { ...value, startedAt: value.startedAt.toISOString() };
  }
  return cardStopwatchSchema.safeParse(value).data ?? null;
}

export function cardDto(card: Pick<WorkspaceRow<'cards'>, 'id' | 'name' | 'revision' | 'createdAt' | 'updatedAt' | 'rank'
  | 'kind' | 'type' | 'closed' | 'dueDate' | 'dueDateCompleted' | 'isDueCompleted'>, board: BoardAccessContext, list: WorkspaceRow<'lists'>) {
  return {
    id: card.id, name: card.name, revision: card.revision, createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt?.toISOString() ?? null, rank: card.rank == null ? null : decodeRank(card.rank).toString(),
    boardId: board.board.id, listId: list.id, type: card.type, kind: card.kind,
    closed: cardClosed(card, list), ...cardDue(card), permissions: cardPermissions(board, list),
  };
}
