import { randomUUID } from 'node:crypto';
import { commentMentions, removedComment, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { boardCardFollowers } from './affiliation-edges.js';
import { requireCapability, WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { readTerminalDeletionReceipt } from './deletion-receipt.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { planPersonalFollow } from './personal-follows.js';
import { requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Comment = WorkspaceRow<'comments'>;
type CommentAccess = { comment: Comment; card: CardAccessContext; authoredByActor: boolean };
const audit = (action: string, id: string) => ({ action, resourceId: id, resourceType: 'comment' });
const invalidation = (boardId: string) => [{ boardId, kind: 'board.invalidated', payload: {} }];
const receipt = (id: string, revision: number, cardRevision: number) => ({ data: { id, revision, cardRevision } });

export function commentPermissions(context: CardAccessContext, authoredByActor: boolean) {
  return {
    canEdit: authoredByActor && context.permissions.canComment,
    canDelete: authoredByActor ? context.permissions.canComment : context.board.permissions.canManage,
  };
}

export async function authorizeCommentCreate(scope: WorkspaceAuthorization, id: string) {
  const card = await scope.requireCard(id);
  requireCapability(card.permissions.canComment);
  return card;
}

export async function authorizeCommentEdit(scope: WorkspaceAuthorization, id: string): Promise<CommentAccess> {
  const access = await scope.requireComment(id);
  const authoredByActor = access.comment.authorId === scope.actor.id;
  requireCapability(commentPermissions(access.card, authoredByActor).canEdit);
  return { ...access, authoredByActor };
}

export async function authorizeCommentDelete(database: Db, scope: WorkspaceAuthorization,
  input: RelationshipCommandInput<'comments.delete'>, key?: string): Promise<CommentAccess | undefined> {
  try {
    const access = await scope.requireComment(input.id);
    const authoredByActor = access.comment.authorId === scope.actor.id;
    requireCapability(commentPermissions(access.card, authoredByActor).canDelete);
    return { ...access, authoredByActor };
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !key) throw error;
    const parsed = removedComment.safeParse(await readTerminalDeletionReceipt(database, scope, 'comments.delete', key, input));
    if (!parsed.success || parsed.data.data.id !== input.id) throw error;
    const { cardId, authoredByActor } = parsed.data.data;
    const card = await scope.requireCard(cardId);
    requireCapability(commentPermissions(card, authoredByActor).canDelete);
  }
}

async function commentDeliveries(records: WorkspaceRecords, card: WorkspaceRow<'cards'>, commentId: string, text: string,
  { generationId, actorId, commandId, timestamp }: CommandPlanningContext): Promise<PlannedEffect[]> {
  const { boardId, id: cardId } = card;
  const followers = await boardCardFollowers(records, generationId, boardId, cardId);
  const mentions = new Set(commentMentions(text).map(({ id }) => id));
  const candidates = new Set([...followers, ...mentions]);
  candidates.delete(actorId);
  if (!candidates.size) return [];
  const recipients = await eligibleBoardPeople(records, generationId, boardId, { id: { $in: [...candidates] } }, [{ $sort: { id: 1 } }]);
  return recipients.map(({ id: recipientId }) => ({
    kind: 'insert', collection: 'notifications', id: randomUUID(), fields: {
      recipientId, actorId, boardId, cardId, commentId, commandId,
      kind: mentions.has(recipientId) ? 'mentionInComment' : 'commentCard', readAt: null, createdAt: timestamp, updatedAt: null,
    },
  }));
}

export async function planCommentCreate(records: WorkspaceRecords, { card }: CardAccessContext,
  input: RelationshipCommandInput<'comments.create'>, context: CommandPlanningContext): Promise<CommandPlan> {
  const { actorId: authorId, timestamp } = context;
  const parent = touchRevision('cards', card, timestamp, input.expectedRevision);
  const id = randomUUID();
  const account = await context.read('users', authorId);
  const preferences = account?.preferences;
  const follow = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    && 'followOnComment' in preferences && preferences.followOnComment === true
    ? (await planPersonalFollow('card', true, records, card, input.expectedRevision, context)).effects : [];
  return {
    effects: [{ kind: 'insert', collection: 'comments', id, fields: {
      cardId: card.id, boardId: card.boardId, authorId, text: input.text, createdAt: timestamp, updatedAt: null,
    } }, parent, ...follow, ...await commentDeliveries(records, card, id, input.text, context)],
    result: receipt(id, 1, parent.revision + 1), audit: audit('comments.create', id), events: invalidation(card.boardId),
  };
}

export async function planCommentUpdate(_records: WorkspaceRecords, { comment, card: { card } }: CommentAccess,
  input: RelationshipCommandInput<'comments.update'>, { timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const revision = requireRevision(comment, input.expectedRevision)!;
  const id = comment.id;
  const proof = audit('comments.update', id);
  if (input.text === comment.text) return { effects: [], result: receipt(id, revision, card.revision), audit: proof };
  const changed = touchRevision('comments', comment, timestamp, revision);
  const parent = touchRevision('cards', card, timestamp);
  return {
    effects: [{ ...changed, fields: { ...changed.fields, text: input.text } }, parent],
    result: receipt(id, changed.revision + 1, parent.revision + 1), audit: proof, events: invalidation(card.boardId),
  };
}

export async function planCommentDelete(records: WorkspaceRecords, access: CommentAccess | undefined,
  input: RelationshipCommandInput<'comments.delete'>, { timestamp, generationId }: CommandPlanningContext): Promise<CommandPlan> {
  if (!access) throw new WorkspaceAccessError('missing');
  const { comment, card: { card }, authoredByActor } = access;
  const id = comment.id;
  const revision = requireRevision(comment, input.expectedRevision);
  const parent = touchRevision('cards', card, timestamp);
  const deliveries = await records.find('notifications', { commentId: id, cardId: card.id,
    $expr: { $and: [canonicalRow(generationId), equal('commentId', id), equal('cardId', card.id)] },
  }, { id: 1 });
  const children = deliveries.map((row): PlannedEffect => ({ kind: 'delete', collection: 'notifications', id: row.id, revision: rowRevision(row) }));
  return {
    effects: [...children, { kind: 'delete', collection: 'comments', id, revision }, parent],
    result: { data: { id, cardId: card.id, cardRevision: parent.revision + 1, authoredByActor } },
    audit: audit('comments.delete', id), events: invalidation(card.boardId),
  };
}
