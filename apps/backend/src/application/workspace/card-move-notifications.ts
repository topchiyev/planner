import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { createWorkspaceAuthorization, WorkspaceAccessError } from './authorization.js';
import { canonicalRow, equal, publicIdField, type WorkspaceRecords, type WorkspaceRow } from './records.js';

// This runs in the command's writer lease. Candidates are reauthorized against the current board.
export async function singleCardMoveNotifications(database: Db, records: WorkspaceRecords, card: WorkspaceRow<'cards'>,
  activityId: string, { generationId, actorId, commandId, timestamp }: CommandPlanningContext): Promise<PlannedEffect[]> {
  const { boardId, id: cardId } = card;
  const scoped = (field: 'boardId' | 'cardId', value: string) => ({
    [field]: value, $expr: { $and: [canonicalRow(generationId), equal(field, value), publicIdField('userId')] },
  });
  const board = await records.find('boardFollows', scoped('boardId', boardId));
  const cardFollowers = await records.find('cardFollows', scoped('cardId', cardId));
  const recipients = new Set([...board, ...cardFollowers].map(({ userId }) => userId));
  recipients.delete(actorId);

  const effects: PlannedEffect[] = [];
  for (const id of [...recipients].sort()) {
    const user = await records.get('users', id);
    if (!user || user.disabledAt !== null || !['admin', 'projectOwner', 'boardUser'].includes(user.role)) continue;
    const scope = createWorkspaceAuthorization(database, generationId, user);
    try {
      const { permissions } = await scope.requireBoard(boardId);
      if (!permissions.canFollow) continue;
    } catch (error) {
      if (error instanceof WorkspaceAccessError && error.statusCode === 404) continue;
      throw error;
    }
    effects.push({ kind: 'insert', collection: 'notifications', id: randomUUID(), fields: {
      recipientId: id, actorId, boardId, cardId, activityId, commandId, kind: 'moveCard', readAt: null, createdAt: timestamp,
    } });
  }
  return effects;
}
