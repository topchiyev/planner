import type { WorkspaceRow } from '../workspace/records.js';
import { invalidBaseRow, targetTimes } from './base-fields.js';
import { decodeActivitySnapshot, decodeNoticeSnapshot, type ImportedActivitySnapshot, type ImportedNoticeSnapshot } from './discussion-snapshots.js';
import { rewriteImportedMentions } from './historical-mentions.js';
import type { ImportProvenance, ImportRecords } from './staged-records.js';
import type { SourceRow, SourceTable } from './source-projections.js';

export const discussionTables = ['action', 'comment', 'notification'] as const;
type DiscussionTable = typeof discussionTables[number];
export const isDiscussionTable = (table: SourceTable): table is DiscussionTable => (discussionTables as readonly SourceTable[]).includes(table);

type SourceEntry = { [K in DiscussionTable]: { table: K; row: SourceRow<K> } }[DiscussionTable];
type DecodeFailure = 'unsupported-kind' | 'invalid-snapshot';
type QuarantineReason = DecodeFailure | 'missing-card' | 'missing-comment' | 'missing-activity' | 'missing-board' | 'board-mismatch'
  | 'missing-recipient' | 'disabled-recipient' | 'recipient-cannot-read-card' | 'target-kind-mismatch' | 'target-scope-mismatch'
  | 'target-actor-mismatch' | 'assignment-recipient-mismatch';

export type SourceDiscussion = {
  type: 'comment'; cardSourceId: string; authorSourceId: string | null;
} | {
  type: 'action'; cardSourceId: string; actorSourceId: string | null; boardSourceId: string | null;
  decoded: ImportedActivitySnapshot | null; failure: DecodeFailure | null;
} | {
  type: 'notification'; cardSourceId: string; actorSourceId: string | null; boardSourceId: string;
  recipientSourceId: string; commentSourceId: string | null; actionSourceId: string | null;
  decoded: ImportedNoticeSnapshot | null; failure: DecodeFailure | null; isRead: boolean;
};

export function reserveDiscussionRecord(store: ImportRecords, { table, row }: SourceEntry, provenance: ImportProvenance) {
  let discussion: SourceDiscussion;
  switch (table) {
    case 'comment':
      discussion = { type: 'comment', cardSourceId: row.card_id, authorSourceId: row.user_id };
      break;
    case 'action': {
      const decoded = decodeActivitySnapshot(row);
      discussion = { type: 'action', cardSourceId: row.card_id, boardSourceId: row.board_id, actorSourceId: row.user_id,
        decoded: decoded.data ?? null, failure: decoded.reason ?? null };
      break;
    }
    case 'notification': {
      const decoded = decodeNoticeSnapshot(row);
      discussion = { type: 'notification', cardSourceId: row.card_id, boardSourceId: row.board_id, actorSourceId: row.creator_user_id,
        recipientSourceId: row.user_id, commentSourceId: row.comment_id, actionSourceId: row.action_id,
        decoded: decoded.data ?? null, failure: decoded.reason ?? null, isRead: row.is_read };
      break;
    }
  }
  return store.reserve(table, row.id, { ...provenance, discussion });
}

async function findCard(store: ImportRecords, sourceId: string) {
  const id = await store.resolve('card', sourceId);
  return id === null ? null : store.get('cards', id);
}

function findActor(store: ImportRecords, sourceId: string | null) {
  return sourceId === null ? null : store.resolve('user_account', sourceId);
}

function quarantine(store: ImportRecords, runId: string, capturedAt: string, entry: Exclude<SourceEntry, { table: 'comment' }>,
  reasons: readonly QuarantineReason[]) {
  const { table, row } = entry;
  return store.write('importQuarantine', store.publicId(table, row.id), {
    runId, sourceId: row.id, entity: table, reason: reasons[0], reasons: [...reasons],
    ...(table === 'notification' && { sourceIsRead: row.is_read }), ...targetTimes(row, capturedAt),
  });
}

async function writeComment(store: ImportRecords, capturedAt: string, row: SourceRow<'comment'>) {
  const card = await findCard(store, row.card_id);
  if (!card) invalidBaseRow('A source comment has no owning card.');
  const authorId = await findActor(store, row.user_id);
  await store.write('comments', store.publicId('comment', row.id), { ...targetTimes(row, capturedAt),
    cardId: card.id, boardId: card.boardId, authorId, text: await rewriteImportedMentions(row.text, store) });
}

async function writeActivity(store: ImportRecords, runId: string, capturedAt: string, row: SourceRow<'action'>) {
  const decoded = decodeActivitySnapshot(row);
  const card = await findCard(store, row.card_id);
  const failure = decoded.reason ? [decoded.reason] : [];
  if (decoded.reason || !card) {
    return quarantine(store, runId, capturedAt, { table: 'action', row }, [...failure, ...(!card ? ['missing-card' as const] : [])]);
  }
  const [boardId, actorId] = await Promise.all([
    row.board_id === null ? null : store.resolve('board', row.board_id),
    findActor(store, row.user_id),
  ]);
  await store.write('activities', store.publicId('action', row.id), { ...targetTimes(row, capturedAt),
    kind: decoded.data.kind, cardId: card.id, boardId, actorId });
}

async function commentTarget(store: ImportRecords, sourceId: string | null, kind: string | undefined, row: SourceRow<'notification'>,
  card: WorkspaceRow<'cards'> | null, reasons: QuarantineReason[]) {
  const mapping = sourceId === null ? null : await store.mapping('comment', sourceId);
  const comment = mapping ? await store.get('comments', mapping.id) : null;
  if (!comment) reasons.push('missing-comment');
  else {
    if (kind !== 'commentCard' && kind !== 'mentionInComment') reasons.push('target-kind-mismatch');
    if (card && (comment.cardId !== card.id || comment.boardId !== card.boardId)) reasons.push('target-scope-mismatch');
    const source = mapping?.provenance.discussion;
    if (source?.type === 'comment' && source.authorSourceId !== null && row.creator_user_id !== null
      && source.authorSourceId !== row.creator_user_id) reasons.push('target-actor-mismatch');
  }
  return comment?.id ?? null;
}

async function activityTarget(store: ImportRecords, sourceId: string | null, kind: string | undefined, row: SourceRow<'notification'>,
  card: WorkspaceRow<'cards'> | null, reasons: QuarantineReason[]) {
  const mapping = sourceId === null ? null : await store.mapping('action', sourceId);
  const activity = mapping ? await store.get('activities', mapping.id) : null;
  if (!activity) reasons.push('missing-activity');
  else {
    if (activity.kind !== kind || (kind !== 'moveCard' && kind !== 'assignCard')) reasons.push('target-kind-mismatch');
    const source = mapping?.provenance.discussion;
    if ((card && activity.cardId !== card.id) || (source?.type === 'action' && source.boardSourceId !== null
      && row.board_id !== source.boardSourceId)) reasons.push('target-scope-mismatch');
    if (source?.type === 'action' && source.actorSourceId !== null && row.creator_user_id !== null
      && source.actorSourceId !== row.creator_user_id) reasons.push('target-actor-mismatch');
    if (source?.type === 'action' && source.decoded?.kind === 'assignCard' && source.decoded.snapshot.user.id !== row.user_id) {
      reasons.push('assignment-recipient-mismatch');
    }
  }
  return activity?.id ?? null;
}

async function writeNotice(store: ImportRecords, runId: string, capturedAt: string, row: SourceRow<'notification'>) {
  const decoded = decodeNoticeSnapshot(row);
  const kind = decoded.data?.kind;
  const [card, boardId, recipientId, actorId] = await Promise.all([
    findCard(store, row.card_id), store.resolve('board', row.board_id), store.resolve('user_account', row.user_id),
    findActor(store, row.creator_user_id),
  ]);
  const reasons: QuarantineReason[] = [];
  if (decoded.reason) reasons.push(decoded.reason);
  if (!card) reasons.push('missing-card');
  if (!boardId) reasons.push('missing-board');
  if (card && boardId && card.boardId !== boardId) reasons.push('board-mismatch');
  const expectsComment = kind === 'commentCard' || kind === 'mentionInComment';
  if ((expectsComment && row.action_id !== null) || (kind && !expectsComment && row.comment_id !== null)) {
    reasons.push('target-kind-mismatch');
  }
  const commentId = expectsComment || row.comment_id !== null ? await commentTarget(store, row.comment_id, kind, row, card, reasons) : null;
  const activityId = (!expectsComment && kind !== undefined) || row.action_id !== null
    ? await activityTarget(store, row.action_id, kind, row, card, reasons) : null;
  const recipient = recipientId ? await store.get('users', recipientId) : null;
  if (!recipient) reasons.push('missing-recipient');
  else if (recipient.disabledAt !== null) reasons.push('disabled-recipient');
  else if (card && !await store.recipientCanReadCard(recipient, card)) reasons.push('recipient-cannot-read-card');
  if (decoded.data?.kind === 'assignCard' && decoded.data.snapshot.user.id !== row.user_id && !reasons.includes('assignment-recipient-mismatch')) {
    reasons.push('assignment-recipient-mismatch');
  }
  if (reasons.length > 0) {
    return quarantine(store, runId, capturedAt, { table: 'notification', row }, [...new Set(reasons)]);
  }
  if (!kind || !card || !boardId || !recipientId) invalidBaseRow('A source inbox record has an unresolved scope.');
  const { createdAt, updatedAt } = targetTimes(row, capturedAt);
  await store.write('notifications', store.publicId('notification', row.id), {
    boardId, cardId: card.id, recipientId, actorId, commentId, activityId, kind, createdAt, updatedAt,
    readAt: row.is_read ? updatedAt ?? createdAt : null,
  });
}

export async function writeImportedDiscussion(store: ImportRecords, runId: string, capturedAt: string, { table, row }: SourceEntry) {
  switch (table) {
    case 'action': return writeActivity(store, runId, capturedAt, row);
    case 'comment': return writeComment(store, capturedAt, row);
    case 'notification': return writeNotice(store, runId, capturedAt, row);
  }
}
