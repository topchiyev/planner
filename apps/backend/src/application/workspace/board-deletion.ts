import type { Document } from 'mongodb';
import type { PlannedEffect } from '../command-journal/operation.js';
import { requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, together, type WorkspaceRecordName, type WorkspaceRecords, type WorkspaceRow } from './records.js';

const queryBatchSize = 512;

export async function planBoardDescendants(records: WorkspaceRecords, generationId: string, boardId: string, timestamp: string) {
  function find<K extends WorkspaceRecordName>(collection: K, selector: Document, ...checks: Document[]) {
    return records.find(collection, { ...selector, $expr: { $and: [canonicalRow(generationId), ...checks] } }, { id: 1 });
  }
  function exact<K extends WorkspaceRecordName>(collection: K, field: string, id: string) {
    return find(collection, { [field]: id }, equal(field, id));
  }
  async function byIds<K extends WorkspaceRecordName>(collection: K, field: string, ids: string[], selector: Document = {}, ...checks: Document[]) {
    const rows: WorkspaceRow<K>[] = [];
    for (let offset = 0; offset < ids.length; offset += queryBatchSize) {
      const batch = ids.slice(offset, offset + queryBatchSize);
      rows.push(...await find(collection, { ...selector, [field]: { $in: batch } },
        { $in: ['$' + field, batch] }, ...checks));
    }
    return rows;
  }
  const ids = (rows: readonly { id: string }[]) => rows.map(({ id }) => id);
  const keyed = <T extends { id: string }>(rows: readonly T[]) => new Map(rows.map((row) => [row.id, row]));
  const effects: PlannedEffect[] = [];
  function remove<K extends WorkspaceRecordName>(collection: K, rows: WorkspaceRow<K>[]) {
    const unique = keyed(rows);
    for (const id of [...unique.keys()].sort()) {
      effects.push({ kind: 'delete', collection, id, revision: rowRevision(unique.get(id)!) });
    }
  }

  const [lists, cards, labels, preferences, members, boardFollows, boardGroups] = await together([
    exact('lists', 'boardId', boardId), exact('cards', 'boardId', boardId), exact('labels', 'boardId', boardId),
    exact('boardPreferences', 'boardId', boardId), exact('boardMembers', 'boardId', boardId), exact('boardFollows', 'boardId', boardId),
    find('fieldGroups', { scopeType: 'board', scopeId: boardId }, equal('scopeType', 'board'), equal('scopeId', boardId)),
  ]);
  const cardIds = ids(cards);
  const [checklists, linkedTasks, cardGroups, cardLabels, labelAssignments, assignees, follows, values, comments, attachments] = await together([
    byIds('checklists', 'cardId', cardIds), byIds('tasks', 'linkedCardId', cardIds),
    byIds('fieldGroups', 'scopeId', cardIds, { scopeType: 'card' }, equal('scopeType', 'card')),
    byIds('cardLabels', 'cardId', cardIds), byIds('cardLabels', 'labelId', ids(labels)),
    byIds('cardAssignees', 'cardId', cardIds), byIds('cardFollows', 'cardId', cardIds),
    byIds('fieldValues', 'cardId', cardIds), byIds('comments', 'cardId', cardIds), byIds('attachments', 'cardId', cardIds),
  ]);
  const groups = [...boardGroups, ...cardGroups];
  const [tasks, definitions, groupValues] = await together([
    byIds('tasks', 'checklistId', ids(checklists)), byIds('fieldDefinitions', 'fieldGroupId', ids(groups)),
    byIds('fieldValues', 'fieldGroupId', ids(groups)),
  ]);
  // A transferred card may still have rows with the old board in their historical context.
  // Card-backed feed rows follow the current card; a board-only row belongs to its board.
  for (const collection of ['activities', 'notifications'] as const) {
    const [cardFeed, boardFeed] = await together([
      byIds(collection, 'cardId', cardIds),
      find(collection, { boardId, cardId: null }, equal('boardId', boardId), { $in: [{ $type: '$cardId' }, ['null', 'missing']] }),
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
  remove('labels', labels);
  remove('lists', lists);
  remove('boardFollows', boardFollows);
  remove('boardMembers', members);
  remove('boardPreferences', preferences);

  const ownedChecklistIds = new Set(ids(checklists));
  const pending = linkedTasks.filter((row) => !ownedChecklistIds.has(row.checklistId));
  const unique = (values: string[]) => [...new Set(values)].sort();
  const externalChecklists = keyed(await byIds('checklists', 'id', unique(pending.map(({ checklistId }) => checklistId))));
  const externalCards = keyed(await byIds('cards', 'id', unique([...externalChecklists.values()].map(({ cardId }) => cardId))));
  const [ownerLists, ownerBoards] = await together([
    byIds('lists', 'id', unique([...externalCards.values()].map(({ listId }) => listId))),
    byIds('boards', 'id', unique([...externalCards.values()].map((card) => card.boardId).filter((id) => id !== boardId))),
  ]);
  const externalLists = keyed(ownerLists);
  const survivingBoards = keyed(ownerBoards);
  const targets = keyed(cards);
  const targetLists = keyed(lists);
  const changedCards = new Map<string, WorkspaceRow<'cards'>>();
  const changedChecklists = new Map<string, WorkspaceRow<'checklists'>>();
  const otherBoardIds = new Set<string>();

  for (const task of [...keyed(pending).values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const checklist = externalChecklists.get(task.checklistId);
    const card = checklist && externalCards.get(checklist.cardId);
    const target = task.linkedCardId && targets.get(task.linkedCardId);
    if (!checklist || !card || !target || !survivingBoards.has(card.boardId) || externalLists.get(card.listId)?.boardId !== card.boardId) continue;

    const revision = requireRevision(task, task.revision, true);
    effects.push({ kind: 'update', collection: 'tasks', id: task.id, revision, fields: {
      linkedCardId: null, linkedUnavailable: true, name: null, completed: null, updatedAt: timestamp,
      linkedUnavailableProvenance: {
        id: target.id, name: Array.from(target.name).slice(0, 512).join(''),
        completed: target.closed ?? targetLists.get(target.listId)?.kind === 'closed',
      },
    } });
    changedCards.set(card.id, card);
    changedChecklists.set(checklist.id, checklist);
    otherBoardIds.add(card.boardId);
  }
  for (const id of [...changedChecklists.keys()].sort()) effects.push(touchRevision('checklists', changedChecklists.get(id)!, timestamp));
  for (const id of [...changedCards.keys()].sort()) effects.push(touchRevision('cards', changedCards.get(id)!, timestamp));
  return { effects, otherBoardIds: [...otherBoardIds].sort() };
}
