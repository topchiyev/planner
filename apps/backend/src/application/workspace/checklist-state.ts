import type { RelationshipCommandInput } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlan, PlannedEffect } from '../command-journal/operation.js';
import { planRankChange, RankAnchorError } from './ordered-ranks.js';
import { RelationshipError, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, rankSort, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Card = WorkspaceRow<'cards'>;
type Checklist = WorkspaceRow<'checklists'>;
export type Task = WorkspaceRow<'tasks'>;

export const isUnavailableTask = (task: Pick<Task, 'linkedUnavailable'>) =>
  task.linkedUnavailable != null && task.linkedUnavailable !== false;

export const liveTaskMarker = { $or: [
  { $in: [{ $type: '$linkedUnavailable' }, ['null', 'missing']] },
  { $eq: ['$linkedUnavailable', false] },
] };
export type TaskWrite = RelationshipCommandInput<'tasks.update'>;

export const checklistOrderVersion = (card: Pick<Card, 'checklistOrderVersion'>) => revisionSchema.parse(card.checklistOrderVersion ?? 1);
export const taskOrderVersion = (checklist: Pick<Checklist, 'orderVersion'>) => revisionSchema.parse(checklist.orderVersion ?? 1);

export function nextOrderVersion(current: number) {
  const next = revisionSchema.safeParse(current + 1);
  if (!next.success) throw new RelationshipError('checklistOrder');
  return next.data;
}

export function changedCard(card: Card, timestamp: string, order: boolean) {
  const effect = touchRevision('cards', card, timestamp);
  const version = checklistOrderVersion(card);
  const next = order ? nextOrderVersion(version) : version;
  return { effect: { ...effect, fields: { ...effect.fields, ...(order && { checklistOrderVersion: next }) } },
    revision: effect.revision + 1, orderVersion: next };
}

export function changedChecklist(checklist: Checklist, timestamp: string, order: boolean) {
  const effect = touchRevision('checklists', checklist, timestamp);
  const version = taskOrderVersion(checklist);
  const next = order ? nextOrderVersion(version) : version;
  return { effect: { ...effect, fields: { ...effect.fields, ...(order && { orderVersion: next }) } },
    position: { checklistId: checklist.id, revision: effect.revision + 1, orderVersion: next } };
}

export const checklistPosition = (checklist: Checklist) => ({
  checklistId: checklist.id, revision: checklist.revision, orderVersion: taskOrderVersion(checklist),
});

export function checklistRows(records: WorkspaceRecords, generationId: string, cardId: string) {
  return records.find('checklists', { cardId, $expr: { $and: [canonicalRow(generationId), equal('cardId', cardId)] } }, rankSort);
}

export function taskRows(records: WorkspaceRecords, generationId: string, checklistId: string) {
  return records.find('tasks', { checklistId, $expr: { $and: [canonicalRow(generationId), equal('checklistId', checklistId)] } }, rankSort);
}

export function placeInOrder<K extends 'checklists' | 'tasks'>(collection: K, rows: WorkspaceRow<K>[],
  id: string, before: string | null, timestamp: string) {
  let ranks: ReturnType<typeof planRankChange>;
  try {
    ranks = planRankChange(rows.map((row) => ({ id: row.id, rank: row.rank == null ? null : decodeRank(row.rank) })), id, before);
  } catch (error) {
    if (error instanceof RankAnchorError) throw new RelationshipError('checklistOrder');
    throw error;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const effects: PlannedEffect[] = [];
  let movingRank: string | undefined;
  for (const change of ranks) {
    if (change.id === id) movingRank = change.rank.toString();
    else {
      const touch = touchRevision(collection, byId.get(change.id)!, timestamp);
      effects.push({ ...touch, fields: { ...touch.fields, rank: change.rank.toString() } });
    }
  }
  return { movingRank, effects, reordered: ranks.length > 0 };
}

export const checklistEvent = (card: Card, revision: number): NonNullable<CommandPlan['events']> => [
  { boardId: card.boardId, kind: 'card.changed', payload: { id: card.id, revision } },
];
