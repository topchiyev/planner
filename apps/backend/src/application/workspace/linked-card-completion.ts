import type { PlannedEffect } from '../command-journal/operation.js';
import { requireRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';

// Call when effective target completion changes. All live links change their projection even if a cached task value already matches.
export async function planLinkedCardCompletion(records: WorkspaceRecords, generationId: string,
  target: { id: string; boardId: string }, completed: boolean, timestamp: string,
) {
  const canonical = canonicalRow(generationId);
  type Match = WorkspaceRow<'tasks'> & { owner: WorkspaceRow<'checklists'>; ownerCard: WorkspaceRow<'cards'> };
  const rows = await records.aggregate<Match>('tasks', {
    linkedCardId: target.id, linkedUnavailable: { $ne: true },
    $expr: { $and: [canonical, equal('linkedCardId', target.id)] },
  }, [
    records.lookup('checklists', 'owner', { checklistId: '$checklistId' }, {
      $expr: { $and: [canonical, { $eq: ['$id', '$$checklistId'] }] },
    }),
    { $unwind: '$owner' },
    records.lookup('cards', 'ownerCard', { cardId: '$owner.cardId' }, {
      $expr: { $and: [canonical, { $eq: ['$id', '$$cardId'] }] },
    }),
    { $unwind: '$ownerCard' },
    records.lookup('lists', 'ownerList', { listId: '$ownerCard.listId', boardId: '$ownerCard.boardId', kind: '$ownerCard.kind' }, {
      $expr: { $and: [canonical, { $eq: ['$id', '$$listId'] }, { $eq: ['$boardId', '$$boardId'] }, {
        $eq: ['$$kind', { $cond: [{ $in: ['$kind', ['active', 'closed']] }, 'board', '$kind'] }],
      }] },
    }, [{ $project: { _id: 1 } }, { $limit: 1 }]),
    records.lookup('boards', 'ownerBoard', { boardId: '$ownerCard.boardId' }, {
      $expr: { $and: [canonical, { $eq: ['$id', '$$boardId'] }] },
    }, [{ $project: { _id: 1 } }, { $limit: 1 }]),
    { $match: { 'ownerList.0': { $exists: true }, 'ownerBoard.0': { $exists: true } } },
    { $sort: { id: 1 } },
  ]);

  const effects: PlannedEffect[] = [];
  const checklists = new Map<string, WorkspaceRow<'checklists'>>();
  const cards = new Map<string, WorkspaceRow<'cards'>>();
  const boards = new Set<string>();
  for (const task of rows) {
    const { owner, ownerCard } = task;
    effects.push({ kind: 'update', collection: 'tasks', id: task.id, revision: requireRevision(task, task.revision, true),
      fields: { completed, updatedAt: timestamp } });
    checklists.set(owner.id, owner);
    if (ownerCard.id !== target.id) cards.set(ownerCard.id, ownerCard);
    if (ownerCard.id !== target.id || ownerCard.boardId !== target.boardId) boards.add(ownerCard.boardId);
  }
  for (const id of [...checklists.keys()].sort()) effects.push(touchRevision('checklists', checklists.get(id)!, timestamp));
  for (const id of [...cards.keys()].sort()) effects.push(touchRevision('cards', cards.get(id)!, timestamp));
  return { effects, events: [...boards].sort().map((boardId) => ({ boardId, kind: 'board.invalidated', payload: {} })) };
}
