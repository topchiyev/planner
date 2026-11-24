import { workspaceCardContext, type WorkspaceReadInput } from '@planner/contracts';
import { publicIdSchema, signedInt64TextSchema, utcInstantSchema } from '@planner/contracts/storage';
import { MongoServerError, type Document } from 'mongodb';
import { encodeRank } from '../../storage/identity.js';
import { InvalidPageCursor, pageCursors, type CursorScope } from '../pagination/cursor.js';
import type { BoardAccessContext } from './authorization.js';
import { directBoardRole, type WorkspaceRecords } from './records.js';

export const escapeSearch = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
function searchFields(pattern: string, fields: string[]) {
  return { $or: fields.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } })) };
}

export function textQuery(value: string, fields: string[]) {
  const terms = [...new Set(value.normalize('NFC').toLowerCase().split(/[\s,;]+/u).filter(Boolean))].sort();
  return { binding: JSON.stringify(terms), filter: terms.length ? { $and: terms.map((term) => searchFields(escapeSearch(term), fields)) } : {} };
}

export function cardSearch(value: string) {
  const fields = ['name', 'description'];
  if (!value.startsWith('/')) return { ...textQuery(value, fields), bounded: false, valid: true };
  const expression = value.slice(1, -1);
  // Only accept constructs shared by RE2 and the server matcher. The server caps each match and query.
  let valid = value.startsWith('/') && value.endsWith('/') && expression.length > 0 && expression.length <= 128
    && !/\(\?(?!:)|\(\*|\\[1-9gkKQRCXZAGz]|\+\+|\*\+|\?\+|\}\+/u.test(expression);
  if (valid) {
    try { new RegExp(expression, 'iu'); } catch { valid = false; }
  }
  return { binding: value, filter: valid ? searchFields('(*LIMIT_MATCH=10000)(*LIMIT_DEPTH=100)' + expression, fields) : {},
    bounded: true, valid };
}

export function rejectedPattern(error: unknown) {
  return error instanceof MongoServerError && (error.code === 50 || error.code === 51111
    || /regular expression|match limit|depth limit/iu.test(error.message));
}

type Context = WorkspaceReadInput<'boardCards'>['context'];
export const contextKinds = {
  board: ['active', 'closed'], archive: ['archive'], trash: ['trash'],
} as const satisfies Record<ReturnType<typeof workspaceCardContext.parse>, readonly string[]>;

export function cardPlacementStages(records: WorkspaceRecords, boardId: string, context: Context): Document[] {
  return [
    records.lookup('lists', 'placement', { listId: '$listId' }, {
      boardId, kind: { $in: contextKinds[context] }, $expr: { $eq: ['$id', '$$listId'] },
    }, [{ $limit: 1 }]),
    { $match: { 'placement.0': { $exists: true } } },
  ];
}

export async function cardFilters(records: WorkspaceRecords, board: BoardAccessContext, query: WorkspaceReadInput<'boardCards'>) {
  const stages: Document[] = [];
  const boardId = board.board.id;
  const labels = [...new Set([...query.labelsAny, ...query.labelsNone])];
  if (labels.length) {
    const owned = new Set((await records.find('labels', { boardId, id: { $in: labels } })).map((row) => row.id));
    const any = query.labelsAny.filter((id) => owned.has(id));
    const none = query.labelsNone.filter((id) => owned.has(id));
    if (query.labelsAny.length) {
      stages.push(records.lookup('cardLabels', 'includedLabels', { cardId: '$id' }, {
        labelId: { $in: any }, $expr: { $eq: ['$cardId', '$$cardId'] },
      }, [{ $limit: 1 }]), { $match: { 'includedLabels.0': { $exists: true } } });
    }
    if (none.length) {
      stages.push(records.lookup('cardLabels', 'excludedLabels', { cardId: '$id' }, {
        labelId: { $in: none }, $expr: { $eq: ['$cardId', '$$cardId'] },
      }, [{ $limit: 1 }]), { $match: { 'excludedLabels.0': { $exists: false } } });
    }
  }
  if (query.members.length) {
    const members = await records.find('boardMembers', { boardId, userId: { $in: query.members }, $expr: directBoardRole });
    const users = members.map(({ userId }) => userId);
    stages.push(
      records.lookup('cardAssignees', 'matchedAssignees', { cardId: '$id' }, {
        userId: { $in: users }, $expr: { $eq: ['$cardId', '$$cardId'] },
      }, [{ $limit: 1 }]),
      records.lookup('checklists', 'matchedChecklists', { cardId: '$id' }, {
        $expr: { $eq: ['$cardId', '$$cardId'] },
      }, [
        records.lookup('tasks', 'matchingTasks', { checklistId: '$id' }, {
          assigneeId: { $in: users }, $expr: { $eq: ['$checklistId', '$$checklistId'] },
        }, [{ $limit: 1 }]),
        { $match: { 'matchingTasks.0': { $exists: true } } },
        { $limit: 1 },
      ]),
      { $match: { $or: [{ 'matchedAssignees.0': { $exists: true } }, { 'matchedChecklists.0': { $exists: true } }] } },
    );
  }
  if (query.unassigned) {
    stages.push(
      records.lookup('cardAssignees', 'hasAssignee', { cardId: '$id' }, { $expr: { $eq: ['$cardId', '$$cardId'] } }, [{ $limit: 1 }]),
      { $match: { 'hasAssignee.0': { $exists: false } } },
    );
  }
  return stages;
}

type OrderedField = { field: string; type: 'rank' | 'instant' | 'name' | 'id'; direction: 1 | -1 };
export type PagePosition = { [name: string]: string | null };
export const rankedOrder = [
  { field: 'rank', type: 'rank', direction: 1 }, { field: 'id', type: 'id', direction: 1 },
] as const satisfies OrderedField[];
export const historyOrder = [
  { field: 'listChangedAt', type: 'instant', direction: -1 }, { field: 'historySequence', type: 'rank', direction: -1 },
  { field: 'id', type: 'id', direction: -1 },
] as const satisfies OrderedField[];
export const datedOrder = [
  { field: 'createdAt', type: 'instant', direction: -1 }, { field: 'id', type: 'id', direction: -1 },
] as const satisfies OrderedField[];

export function readPage(order: readonly OrderedField[], scope: CursorScope, limit: number, cursor?: string, anchor?: PagePosition) {
  const sort = Object.fromEntries(order.map(({ field, direction }) => [field, direction]));
  const stages: Document[] = [];
  if (cursor) {
    const decoded = anchor ?? pageCursors.decode(scope, cursor);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).length !== order.length) {
      throw new InvalidPageCursor('The page cursor has an invalid position.');
    }
    const position = decoded as PagePosition;
    const values = order.map(({ field, type }) => {
      const value = position[field];
      if (value === null && type !== 'id' && type !== 'name') return null;
      if (type === 'rank' && signedInt64TextSchema.safeParse(value).success) return encodeRank(value!);
      if (type === 'instant' && utcInstantSchema.safeParse(value).success) return new Date(value!);
      if (type === 'id' && publicIdSchema.safeParse(value).success) return value;
      if (type === 'name' && typeof value === 'string') return value;
      throw new InvalidPageCursor('The page cursor has an invalid position.');
    });
    const equals = (n: number) => ({ $eq: [{ $ifNull: ['$' + order[n].field, null] }, { $literal: values[n] }] });
    stages.push({ $match: { $expr: { $or: order.map(({ direction, field }, index) => ({ $and: [
      ...order.slice(0, index).map((_, i) => equals(i)),
      { [direction === 1 ? '$gt' : '$lt']: [{ $ifNull: ['$' + field, null] }, { $literal: values[index] }] },
    ] })) } } });
  }
  stages.push({ $sort: sort }, { $limit: limit + 1 });
  return {
    stages,
    result<T extends object>(rows: T[], project: (row: T) => PagePosition) {
      const selected = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? pageCursors.encode(scope, project(selected[limit - 1])) : null;
      return { selected, page: { nextCursor } };
    },
  };
}
