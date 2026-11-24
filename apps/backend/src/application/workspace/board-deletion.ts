import type { CommandPlanningContext } from '../command-journal/operation.js';
import { createDeletionScope, planCardDescendants } from './card-deletion.js';
import { equal, together, type WorkspaceRecords } from './records.js';

export async function planBoardDescendants(records: WorkspaceRecords, boardId: string, context: CommandPlanningContext) {
  const { find, exact, remove, effects } = createDeletionScope(records, context.generationId);
  const [lists, cards, labels, preferences, members, boardFollows, groups] = await together([
    exact('lists', 'boardId', boardId), exact('cards', 'boardId', boardId), exact('labels', 'boardId', boardId),
    exact('boardPreferences', 'boardId', boardId), exact('boardMembers', 'boardId', boardId), exact('boardFollows', 'boardId', boardId),
    find('fieldGroups', { scopeType: 'board', scopeId: boardId }, equal('scopeType', 'board'), equal('scopeId', boardId)),
  ]);
  const descendants = await planCardDescendants(records, cards, lists, context, { id: boardId, labels, groups });
  remove('labels', labels);
  remove('lists', lists);
  remove('boardFollows', boardFollows);
  remove('boardMembers', members);
  remove('boardPreferences', preferences);
  return { effects: [...descendants.effects, ...effects], otherBoardIds: descendants.otherBoardIds };
}
