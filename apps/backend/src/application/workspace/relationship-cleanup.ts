import { revisionSchema } from '@planner/contracts/storage';
import type { Document } from 'mongodb';
import type { PlannedEffect } from '../command-journal/operation.js';
import { RelationshipError, rowRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, together, type WorkspaceRecords, type WorkspaceRow } from './records.js';

const stableIds = { $sort: { id: 1 } };
const targets = { $project: { _id: 1, generationId: 1, id: 1, revision: 1 } };
type Parent = Pick<WorkspaceRow<'cards'>, '_id' | 'generationId' | 'id' | 'revision'>;
type TaskCleanup = WorkspaceRow<'tasks'> & { owningChecklist: [Parent & { ownedCard: [Parent] }] };

export async function planMembershipCleanup(
  records: WorkspaceRecords, generationId: string, boardId: string, userId: string, timestamp: string,
): Promise<PlannedEffect[]> {
  const exact = canonicalRow(generationId);
  function owningCard(): Document {
    return records.lookup('cards', 'ownedCard', { sourceCardId: '$cardId' }, {
      boardId, $expr: { $and: [equal('id', '$$sourceCardId'), equal('boardId', boardId), exact] },
    }, [
      records.lookup('lists', 'owningList', { sourceListId: '$listId' }, {
        boardId, $expr: { $and: [equal('id', '$$sourceListId'), equal('boardId', boardId), exact] },
      }, [{ $limit: 1 }, { $project: { _id: 1 } }]),
      { $match: { 'owningList.0': { $exists: true } } },
      { $limit: 1 }, targets,
    ]);
  }
  const hasCard = { $match: { 'ownedCard.0': { $exists: true } } };
  const links = <T extends 'cardFollows' | 'cardAssignees'>(collection: T) =>
    records.aggregate<WorkspaceRow<T> & { ownedCard: [Parent] }>(
      collection, { userId, $expr: { $and: [exact, equal('userId', userId)] } },
      [owningCard(), hasCard, stableIds, { $project: { ...targets.$project, ownedCard: 1 } }],
    );
  const [boardFollows, cardFollows, assignments, tasks] = await together([
    records.aggregate<WorkspaceRow<'boardFollows'>>('boardFollows', {
      boardId, userId, $expr: { $and: [exact, equal('boardId', boardId), equal('userId', userId)] },
    }, [stableIds, targets]),
    links('cardFollows'),
    links('cardAssignees'),
    records.aggregate<TaskCleanup>('tasks', { assigneeId: userId, $expr: { $and: [exact, equal('assigneeId', userId)] } }, [
      records.lookup('checklists', 'owningChecklist', { sourceChecklistId: '$checklistId' }, {
        $expr: { $and: [equal('id', '$$sourceChecklistId'), exact] },
      }, [owningCard(), hasCard, { $limit: 1 }, { $project: { ...targets.$project, ownedCard: 1 } }]),
      { $match: { 'owningChecklist.0': { $exists: true } } }, stableIds, { $project: { ...targets.$project, owningChecklist: 1 } },
    ]),
  ]);
  const effects: PlannedEffect[] = [];
  for (const [collection, rows] of [['boardFollows', boardFollows], ['cardFollows', cardFollows], ['cardAssignees', assignments]] as const) {
    for (const row of rows) effects.push({ kind: 'delete', collection, id: row.id, revision: rowRevision(row) });
  }
  const cards = new Map(assignments.map(({ ownedCard: [card] }) => [card.id, card]));
  const checklists = new Map<string, Parent>();
  for (const row of tasks) {
    const [checklist] = row.owningChecklist;
    const [card] = checklist.ownedCard;
    checklists.set(checklist.id, checklist);
    cards.set(card.id, card);
    const revision = rowRevision(row);
    if (!revisionSchema.safeParse((revision ?? 0) + 1).success) throw new RelationshipError('stale');
    effects.push({ kind: 'update', collection: 'tasks', id: row.id, revision, fields: { assigneeId: null, updatedAt: timestamp } });
  }
  for (const checklist of checklists.values()) effects.push(touchRevision('checklists', checklist, timestamp));
  for (const card of cards.values()) effects.push(touchRevision('cards', card, timestamp));
  return effects;
}
