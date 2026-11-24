import type { RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { visibleNoticeRows, type Notice } from './feed-reads.js';
import { createWorkspaceRecords, type WorkspaceRecords } from './records.js';
import { requireRevision, rowRevision } from './relationship-policy.js';

const audit = (action: string, id: string) => ({ action, resourceId: id, resourceType: 'notification' });
function setReadState(notice: Notice, expected: number | null, readAt: string | null, timestamp: string): PlannedEffect {
  const revision = requireRevision(notice, expected, true);
  return { kind: 'update', collection: 'notifications', id: notice.id, revision, fields: { updatedAt: timestamp, readAt } };
}

export async function authorizeNotificationUpdate(database: Db, scope: WorkspaceAuthorization, id: string) {
  const records = createWorkspaceRecords(database, scope.generationId);
  const [notice] = await visibleNoticeRows(records, scope, { id });
  if (!notice) throw new WorkspaceAccessError('missing');
  return notice;
}

export async function planNotificationUpdate(_records: WorkspaceRecords, notice: Notice,
  input: RelationshipCommandInput<'notifications.update'>, { timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const revision = requireRevision(notice, input.expectedRevision);
  const { id } = notice;
  const alreadyRead = notice.readAt != null;
  const proof = audit('notifications.update', id);
  if (alreadyRead === input.read) return {
    effects: [], result: { data: { id, revision, readAt: notice.readAt?.toISOString() ?? null } }, audit: proof,
  };
  const readAt = input.read ? timestamp : null;
  return {
    effects: [setReadState(notice, revision, readAt, timestamp)],
    result: { data: { id, revision: (revision ?? 0) + 1, readAt } }, audit: proof,
  };
}

export async function planReadNotifications(records: WorkspaceRecords, card: CardAccessContext | null,
  scope: WorkspaceAuthorization, { timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const notices = await visibleNoticeRows(records, scope, {
    unread: true, ...(card && { cardId: card.card.id, boardId: card.board.board.id }),
  });
  return {
    effects: notices.map((notice) => setReadState(notice, rowRevision(notice), timestamp, timestamp)),
    result: { data: { acknowledged: true } },
    audit: audit(card ? 'notifications.readCard' : 'notifications.readAll', card?.card.id ?? scope.actor.id),
  };
}
