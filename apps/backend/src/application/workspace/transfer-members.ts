import { randomUUID } from 'node:crypto';
import type { CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { together, type WorkspaceRecords, type WorkspaceRow } from './records.js';
import { rowRevision } from './relationship-policy.js';
import { scopedWorkspaceRows } from './scoped-rows.js';
import type { CardTransferIdentity } from './transfer-labels.js';

type Task = WorkspaceRow<'tasks'>;

export async function planTransferPeople(records: WorkspaceRecords, destinationBoardId: string, transfers: CardTransferIdentity[],
  tasks: Task[], context: CommandPlanningContext, duplicate: boolean) {
  const { actorId, generationId, timestamp } = context;
  const { byIds } = scopedWorkspaceRows(records, generationId);
  const cardIds = transfers.map(({ sourceId }) => sourceId);
  const [assignees, follows, people] = await together([
    byIds('cardAssignees', 'cardId', cardIds),
    duplicate ? [] : byIds('cardFollows', 'cardId', cardIds),
    eligibleBoardPeople(records, generationId, destinationBoardId),
  ]);
  const eligible = new Set(people.map(({ id }) => id));
  const effects: PlannedEffect[] = [];
  const stats = { removedAssignees: 0, removedFollows: 0, clearedTaskAssignees: 0 };
  if (!duplicate) {
    for (const row of assignees) if (!eligible.has(row.userId)) {
      effects.push({ kind: 'delete', collection: 'cardAssignees', id: row.id, revision: rowRevision(row) });
      stats.removedAssignees++;
    }
    for (const row of follows) if (!eligible.has(row.userId)) {
      effects.push({ kind: 'delete', collection: 'cardFollows', id: row.id, revision: rowRevision(row) });
      stats.removedFollows++;
    }
    stats.clearedTaskAssignees = tasks.filter(({ assigneeId }) => assigneeId != null && !eligible.has(assigneeId)).length;
    return { effects, eligible, stats };
  }
  const choices = (await context.read('users', actorId))?.preferences;
  const followOwn = choices && typeof choices === 'object' && !Array.isArray(choices) && 'followOwnCards' in choices && choices.followOwnCards === true;
  const destinationBySource = new Map(transfers.map(({ sourceId, destinationId }) => [sourceId, destinationId]));
  const newFollows = new Map<string, Map<string, boolean>>();
  for (const row of assignees) {
    if (!eligible.has(row.userId)) continue;
    const cardId = destinationBySource.get(row.cardId)!;
    effects.push({ kind: 'insert', collection: 'cardAssignees', id: randomUUID(), fields: {
      cardId, userId: row.userId, createdAt: timestamp,
    } });
    const set = newFollows.get(cardId) ?? new Map<string, boolean>();
    set.set(row.userId, false);
    newFollows.set(cardId, set);
  }
  if (followOwn && eligible.has(actorId)) for (const { destinationId } of transfers) {
    const set = newFollows.get(destinationId) ?? new Map<string, boolean>();
    set.set(actorId, true);
    newFollows.set(destinationId, set);
  }
  for (const [cardId, set] of newFollows) for (const [userId, isPermanent] of set) {
    effects.push({ kind: 'insert', collection: 'cardFollows', id: randomUUID(), fields: { cardId, userId, isPermanent, createdAt: timestamp } });
  }
  return { effects, eligible, stats };
}
