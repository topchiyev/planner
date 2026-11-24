import { randomUUID } from 'node:crypto';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { personalFollow } from './affiliation-edges.js';
import { requireCapability, type WorkspaceAuthorization } from './authorization.js';
import { requireRevision, rowRevision } from './relationship-policy.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';

export async function authorizeBoardFollow(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireBoard(id);
  requireCapability(access.permissions.canFollow);
  return access.board;
}

export async function authorizeCardFollow(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireCard(id);
  requireCapability(access.permissions.canFollow);
  return access.card;
}

export async function planPersonalFollow(parent: 'board' | 'card', follow: boolean, records: WorkspaceRecords,
  row: WorkspaceRow<'boards'> | WorkspaceRow<'cards'>, expected: number, { generationId, actorId: userId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  const { id } = row;
  const revision = requireRevision(row, expected)!;
  const existing = await personalFollow(records, generationId, parent, id, userId);
  const collection = parent === 'board' ? 'boardFollows' : 'cardFollows';
  const effects: PlannedEffect[] = [];
  if (!follow && existing) effects.push({ kind: 'delete', collection, id: existing.id, revision: rowRevision(existing) });
  if (follow && !existing) effects.push({ kind: 'insert', collection, id: randomUUID(), fields: {
    userId, createdAt: timestamp, ...(parent === 'board' ? { boardId: id } : { cardId: id, isPermanent: true }),
  } });
  if (parent === 'card' && follow && existing && 'isPermanent' in existing && existing.isPermanent === false) effects.push({
    kind: 'update', collection, id: existing.id, revision: rowRevision(existing), fields: { isPermanent: true },
  });
  return {
    effects, result: { data: { following: follow, revision } },
    audit: { action: parent + 's.' + (follow ? 'follow' : 'unfollow'), resourceType: parent, resourceId: id },
  };
}
