import type { CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { fitsCommandEffect } from '../command-journal/records.js';
import { RelationshipError, requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import { equal, together, type WorkspaceRecordName, type WorkspaceRecords, type WorkspaceRow } from './records.js';

import { scopedWorkspaceRows } from './scoped-rows.js';

type Card = WorkspaceRow<'cards'>;
type List = WorkspaceRow<'lists'>;
const ids = (rows: readonly { id: string }[]) => rows.map(({ id }) => id);
const keyed = <T extends { id: string }>(rows: readonly T[]) => new Map(rows.map((row) => [row.id, row]));

export function createDeletionScope(records: WorkspaceRecords, generationId: string) {
  const { find, exact, byIds } = scopedWorkspaceRows(records, generationId);
  const effects: PlannedEffect[] = [];
  function remove<K extends WorkspaceRecordName>(collection: K, rows: WorkspaceRow<K>[]) {
    const unique = keyed(rows);
    for (const id of [...unique.keys()].sort()) {
      effects.push({ kind: 'delete', collection, id, revision: rowRevision(unique.get(id)!) });
    }
  }
  return { find, exact, byIds, remove, effects };
}

interface RemovedBoard {
  id: string;
  labels: WorkspaceRow<'labels'>[];
  groups: WorkspaceRow<'fieldGroups'>[];
}

export async function planCardDescendants(records: WorkspaceRecords, cards: Card[], victimLists: List[],
  { generationId, timestamp, commandId }: CommandPlanningContext, removedBoard?: RemovedBoard,
) {
  const { find, byIds, remove, effects } = createDeletionScope(records, generationId);
  const cardIds = ids(cards);
  const [checklists, linkedTasks, cardGroups, cardLabels, labelAssignments, assignees, follows, values, comments, attachments] = await together([
    byIds('checklists', 'cardId', cardIds), byIds('tasks', 'linkedCardId', cardIds, { linkedUnavailable: { $ne: true } }),
    byIds('fieldGroups', 'scopeId', cardIds, { scopeType: 'card' }, equal('scopeType', 'card')),
    byIds('cardLabels', 'cardId', cardIds), byIds('cardLabels', 'labelId', ids(removedBoard?.labels ?? [])),
    byIds('cardAssignees', 'cardId', cardIds), byIds('cardFollows', 'cardId', cardIds),
    byIds('fieldValues', 'cardId', cardIds), byIds('comments', 'cardId', cardIds), byIds('attachments', 'cardId', cardIds),
  ]);
  const groups = [...(removedBoard?.groups ?? []), ...cardGroups];
  const [tasks, definitions, groupValues] = await together([
    byIds('tasks', 'checklistId', ids(checklists)), byIds('fieldDefinitions', 'fieldGroupId', ids(groups)),
    byIds('fieldValues', 'fieldGroupId', ids(groups)),
  ]);
  // A transferred card may still have rows with the old board in their historical context.
  // Card-backed feed rows follow the current card; a board-only row belongs to its board.
  for (const collection of ['activities', 'notifications'] as const) {
    const [cardFeed, boardFeed] = await together([
      byIds(collection, 'cardId', cardIds),
      removedBoard ? find(collection, { boardId: removedBoard.id, cardId: null }, equal('boardId', removedBoard.id),
        { $in: [{ $type: '$cardId' }, ['null', 'missing']] }) : [],
    ]);
    remove(collection, [...cardFeed, ...boardFeed]);
  }
  remove('comments', comments);
  remove('attachments', attachments);
  remove('cardLabels', [...cardLabels, ...labelAssignments]);
  remove('cardAssignees', assignees);
  remove('cardFollows', follows);
  remove('fieldValues', [...values, ...groupValues]);
  remove('fieldDefinitions', definitions);
  remove('fieldGroups', groups);
  remove('tasks', tasks);
  remove('checklists', checklists);
  remove('cards', cards);
  const ownedChecklistIds = new Set(ids(checklists));
  const pending = linkedTasks.filter((row) => !ownedChecklistIds.has(row.checklistId));
  const unique = (values: string[]) => [...new Set(values)].sort();
  const externalChecklists = keyed(await byIds('checklists', 'id', unique(pending.map(({ checklistId }) => checklistId))));
  const externalCards = keyed(await byIds('cards', 'id', unique([...externalChecklists.values()].map(({ cardId }) => cardId))));
  const [ownerLists, ownerBoards] = await together([
    byIds('lists', 'id', unique([...externalCards.values()].map(({ listId }) => listId))),
    byIds('boards', 'id', unique([...externalCards.values()].map((card) => card.boardId).filter((id) => id !== removedBoard?.id))),
  ]);
  const externalLists = keyed(ownerLists);
  const survivingBoards = keyed(ownerBoards);
  const targets = keyed(cards);
  const targetLists = keyed(victimLists);
  const changedCards = new Map<string, WorkspaceRow<'cards'>>();
  const changedChecklists = new Map<string, WorkspaceRow<'checklists'>>();
  const otherBoardIds = new Set<string>();

  for (const task of [...keyed(pending).values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const checklist = externalChecklists.get(task.checklistId);
    const card = checklist && externalCards.get(checklist.cardId);
    const target = task.linkedCardId && targets.get(task.linkedCardId);
    const list = card && externalLists.get(card.listId);
    if (!checklist || !card || !target || targets.has(card.id) || !survivingBoards.has(card.boardId) || list?.boardId !== card.boardId) continue;
    const placement = list.kind === 'active' || list.kind === 'closed' ? 'board' : list.kind;
    if (card.kind !== placement) continue;
    const revision = requireRevision(task, task.revision, true);
    const unlink = { kind: 'update', collection: 'tasks', id: task.id, revision, fields: {
      linkedCardId: null, linkedUnavailable: true, name: null, completed: null, updatedAt: timestamp,
      linkedUnavailableProvenance: {
        id: target.id, name: target.name,
        completed: target.closed ?? targetLists.get(target.listId)?.kind === 'closed',
      },
    } } satisfies PlannedEffect;
    if (!fitsCommandEffect({ id: commandId, generationId }, unlink)) throw new RelationshipError(removedBoard ? 'boardDeleteData' : 'trashDeleteData');
    effects.push(unlink);
    changedCards.set(card.id, card);
    changedChecklists.set(checklist.id, checklist);
    otherBoardIds.add(card.boardId);
  }
  for (const id of [...changedChecklists.keys()].sort()) effects.push(touchRevision('checklists', changedChecklists.get(id)!, timestamp));
  for (const id of [...changedCards.keys()].sort()) effects.push(touchRevision('cards', changedCards.get(id)!, timestamp));
  return { effects, otherBoardIds: [...otherBoardIds].sort() };
}
