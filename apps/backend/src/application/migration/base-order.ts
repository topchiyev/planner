import { maximumSignedInt64, rankSpacing } from '@planner/contracts/storage';
import { Long, type Db, type Document } from 'mongodb';
import { invalidBaseRow } from './base-fields.js';
import { compareSourceKeys } from './source-projections.js';

type OrderedTable = 'project' | 'board' | 'list' | 'card';
type OrderRow = { sourceId: string; ordinal: Long | number };

function ordinal(row: OrderRow, spacing: bigint) {
  const value = typeof row.ordinal === 'number' && Number.isSafeInteger(row.ordinal) ? BigInt(row.ordinal)
    : Long.isLong(row.ordinal) ? row.ordinal.toBigInt() : 0n;
  const result = value * spacing;
  if (result <= 0n || result > maximumSignedInt64) invalidBaseRow('The source has more items than the signed rank range can hold.');
  return result;
}

/** Keep rank sorting in MongoDB, and merge its typed numeric IDs with the bounded verified source pages. */
export function openBaseOrder(db: Db, generationId: string, table: OrderedTable, after: string | null, kind: 'rank' | 'history') {
  const history = kind === 'history';
  const match = history ? { 'order.board': { $type: 'string' } } : { 'order.position': { $type: 'number' } };
  const order = history ? { 'order.changedAt': 1, numericId: 1 } : { 'order.position': 1, numericId: 1 };
  const tail: Document[] = after === null ? [] : [{ $match: { numericId: { $gt: Long.fromString(after) } } }];
  const cursor = db.collection('importIds').aggregate<OrderRow>([
    { $match: { generationId, entity: table, ...match } },
    { $project: { _id: 0, order: 1, sourceId: 1, numericId: { $toLong: '$sourceId' } } },
    { $setWindowFields: {
      partitionBy: history ? '$order.board' : '$order.parent',
      sortBy: order,
      output: { ordinal: { $count: {}, window: { documents: ['unbounded', 'current'] } } },
    } },
    ...tail,
    { $sort: { numericId: 1 } },
    { $project: { sourceId: 1, ordinal: 1 } },
  ], { allowDiskUse: true, batchSize: 128, collation: { locale: 'simple' }, promoteLongs: false });
  let pending: OrderRow | null | undefined;
  return {
    async take(sourceId: string) {
      if (pending === undefined) pending = await cursor.next();
      if (pending === null) return null;
      const order = compareSourceKeys(table, pending.sourceId, sourceId);
      if (order > 0) return null;
      if (order < 0) invalidBaseRow('The staged ordering does not match the verified source.');
      const assigned = ordinal(pending, history ? 1n : rankSpacing);
      pending = undefined;
      return assigned;
    },
    async complete() {
      if (pending === undefined) pending = await cursor.next();
      if (pending !== null) invalidBaseRow('The staged ordering does not match the verified source.');
    },
    close: () => cursor.close(),
  };
}

export async function boardHistoryHighWater(db: Db, generationId: string, sourceId: string) {
  const count = await db.collection('importIds').countDocuments({ generationId, entity: 'card', 'order.board': sourceId });
  if (!Number.isSafeInteger(count)) invalidBaseRow('The source has too many card history records.');
  return BigInt(count);
}

export async function assertBoardSystemLists(db: Db, generationId: string, sourceId: string) {
  const ids = db.collection('importIds');
  const count = (kind: 'archive' | 'trash') => ids.countDocuments({ generationId, entity: 'list',
    'reference.parent': sourceId, 'reference.kind': kind }, { limit: 2 });
  const [archive, trash] = await Promise.all([count('archive'), count('trash')]);
  if (archive !== 1 || trash !== 1) invalidBaseRow('Each source board must have one archive list and one trash list.');
}
