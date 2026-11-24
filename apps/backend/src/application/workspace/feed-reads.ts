import { workspaceActivityKind, workspaceNotificationKind, type WorkspaceReadInput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Document } from 'mongodb';
import type { CursorScope } from '../pagination/cursor.js';
import type { WorkspaceAuthorization } from './authorization.js';
import { datedOrder, readPage } from './queries.js';
import { canonicalRow, equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Activity = WorkspaceRow<'activities'>;
type Notice = WorkspaceRow<'notifications'>;
type FeedCard = Pick<WorkspaceRow<'cards'>, 'id' | 'name' | 'boardId' | 'kind'>;
type FeedRow<T> = T & { currentCard: FeedCard };
const activityAliases = { addMemberToCard: 'assignCard', removeMemberFromCard: 'unassignCard' } as const;
const activityKinds = [...workspaceActivityKind.options, ...Object.keys(activityAliases)];
const noticeKinds = [...workspaceNotificationKind.options, 'addMemberToCard'];
const commentKinds = ['commentCard', 'mentionInComment'];
const activityNoticeKinds = ['moveCard', 'assignCard', 'addMemberToCard'];

function activityKind(kind: string) {
  return workspaceActivityKind.parse(activityAliases[kind as keyof typeof activityAliases] ?? kind);
}

function noticeKind(kind: string) {
  return workspaceNotificationKind.parse(kind === 'addMemberToCard' ? 'assignCard' : kind);
}

const iso = (value?: Date | null) => value?.toISOString() ?? null;
const dateFields = ({ id, revision, createdAt, updatedAt }: Activity | Notice) => ({ id, revision, createdAt: createdAt.toISOString(), updatedAt: iso(updatedAt) });
const nullField = (field: string) => ({ $in: [{ $type: '$' + field }, ['missing', 'null']] });
export const unreadNotice = { readAt: null, $expr: nullField('readAt') };

function boardBinding(current: string) {
  return { $or: [equal('boardId', current), nullField('boardId')] };
}

function withCurrentCard(access: WorkspaceAuthorization, boardId?: string): Document[] {
  return [
    access.readableCardLookup('currentCard', '$cardId', true),
    { $unwind: '$currentCard' },
    { $match: { $expr: { $and: [
      boardBinding('$currentCard.boardId'),
      ...(boardId ? [{ $eq: ['$currentCard.boardId', boardId] }] : []),
    ] } } },
  ];
}

const exactKind = (kinds: string[]) => ({ $in: ['$kind', kinds] });

export function noticeFilter(access: WorkspaceAuthorization, id?: string, cardId?: string) {
  const { actor, generationId } = access;
  return { recipientId: actor.id, ...(id && { id }), ...(cardId && { cardId }), kind: { $in: noticeKinds },
    $expr: { $and: [
      canonicalRow(generationId), equal('recipientId', actor.id), exactKind(noticeKinds),
      { $in: [{ $type: '$readAt' }, ['date', 'null', 'missing']] },
      ...(id ? [equal('id', id)] : []), ...(cardId ? [equal('cardId', cardId)] : []),
    ] },
  };
}

export function visibleNoticeStages(records: WorkspaceRecords, access: WorkspaceAuthorization, boardId?: string): Document[] {
  const { generationId } = access;
  const canonical = canonicalRow(generationId);
  return [
    ...withCurrentCard(access, boardId),
    records.lookup('comments', 'liveComment', { id: '$commentId', card: '$currentCard.id', board: '$currentCard.boardId', kind: '$kind' },
      { $expr: { $and: [canonical, equal('id', '$$id'), equal('cardId', '$$card'), equal('boardId', '$$board'), { $in: ['$$kind', commentKinds] }] } },
      [{ $limit: 1 }, { $project: { _id: 1 } }]),
    records.lookup('activities', 'liveActivity', { id: '$activityId', card: '$currentCard.id', board: '$currentCard.boardId', notice: '$kind' },
      { $expr: { $and: [canonical, equal('id', '$$id'), equal('cardId', '$$card'), boardBinding('$$board'),
        { $in: ['$$notice', activityNoticeKinds] }, {
          $or: [
            { $and: [{ $eq: ['$$notice', 'moveCard'] }, equal('kind', 'moveCard')] },
            { $and: [{ $in: ['$$notice', ['assignCard', 'addMemberToCard']] }, exactKind(['assignCard', 'addMemberToCard'])] },
          ],
        }] } }, [{ $limit: 1 }, { $project: { _id: 1 } }]),
    { $match: { $or: [{ 'liveComment.0': { $exists: true } }, { 'liveActivity.0': { $exists: true } }] } },
    { $project: { id: 1, generationId: 1, revision: 1, createdAt: 1, updatedAt: 1, actorId: 1, kind: 1, readAt: 1, currentCard: 1 } },
  ];
}

export function visibleNoticeRows(records: WorkspaceRecords, access: WorkspaceAuthorization, options: { id?: string; cardId?: string; boardId?: string; unread?: boolean } = {}) {
  const { id, cardId, boardId } = options;
  return records.aggregate<FeedRow<Notice>>('notifications', noticeFilter(access, id, cardId), [
    ...(options.unread ? [{ $match: unreadNotice }] : []), ...visibleNoticeStages(records, access, boardId), { $sort: { id: 1 } },
  ]);
}

export function createFeedReads(records: WorkspaceRecords, access: WorkspaceAuthorization,
  cursorScope: (operation: string, order: string, query: readonly string[]) => CursorScope) {
  const { generationId } = access;

  async function actors(rows: readonly (Activity | Notice)[]) {
    const ids = [...new Set(rows.flatMap(({ actorId }) => publicIdSchema.safeParse(actorId).success ? [actorId!] : []))];
    const rowsById = ids.length ? await records.find('users', { id: { $in: ids },
      $expr: { $and: [canonicalRow(generationId), { $in: ['$id', ids] }] },
    }) : [];
    return new Map(rowsById.map(({ id, name, username }) => [id, { id, name, username: username ?? null }]));
  }

  async function activity(boardId: string, cardId: string | null, limit: number, cursor?: string) {
    const scope = cursorScope(cardId ? 'activity.card' : 'activity.board', 'time-id-desc', [boardId, cardId ?? '', String(limit)]);
    const pagination = readPage(datedOrder, scope, limit, cursor);
    const rows = await records.aggregate<FeedRow<Activity>>('activities', {
      ...(cardId ? { cardId } : { boardId: { $in: [boardId, null] } }), kind: { $in: activityKinds },
      $expr: { $and: [
        canonicalRow(generationId), exactKind(activityKinds), boardBinding(boardId), ...(cardId ? [equal('cardId', cardId)] : []),
      ] },
    }, [
      ...withCurrentCard(access, boardId), ...pagination.stages,
      { $project: { id: 1, revision: 1, kind: 1, currentCard: 1, actorId: 1, createdAt: 1, updatedAt: 1 } },
    ]);
    const { selected, page } = pagination.result(rows, (row) => ({ createdAt: iso(row.createdAt), id: row.id }));
    const accounts = await actors(selected);
    return { data: selected.map((row) => ({
      ...dateFields(row), kind: activityKind(row.kind!), card: row.currentCard,
      actor: row.actorId ? accounts.get(row.actorId) ?? null : null,
    })), page };
  }

  return {
    async boardActivity({ id, limit, cursor }: WorkspaceReadInput<'boardActivity'>) {
      await access.requireBoard(id);
      return activity(id, null, limit, cursor);
    },
    async cardActivity({ id, boardId, limit, cursor }: WorkspaceReadInput<'cardActivity'>) {
      const current = await access.requireCard(id, boardId);
      return activity(current.board.board.id, id, limit, cursor);
    },
    async notificationsList({ unread, limit, cursor }: WorkspaceReadInput<'notificationsList'>) {
      const scope = cursorScope('notifications.list', 'time-id-desc', [String(unread), String(limit)]);
      const pagination = readPage(datedOrder, scope, limit, cursor);
      const [result] = await records.aggregate<{ rows: FeedRow<Notice>[]; unread: { count: number }[] }>(
        'notifications', noticeFilter(access), [
          ...visibleNoticeStages(records, access),
          { $facet: {
            rows: [...(unread ? [{ $match: unreadNotice }] : []), ...pagination.stages],
            unread: [{ $match: unreadNotice }, { $count: 'count' }],
          } },
        ],
      );
      const { selected, page } = pagination.result(result?.rows ?? [], (row) => ({ createdAt: iso(row.createdAt), id: row.id }));
      const accounts = await actors(selected);
      return { data: selected.map((row) => ({
        ...dateFields(row), kind: noticeKind(row.kind!), card: row.currentCard, readAt: iso(row.readAt),
        actor: row.actorId ? accounts.get(row.actorId) ?? null : null,
      })), page, unreadCount: Number(result?.unread[0]?.count ?? 0) };
    },
  };
}
