import type { BoardEventFrame } from '@planner/contracts';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { Long, type Db, type Filter } from 'mongodb';
import { decodeRank, encodeRank, workspaceKey } from '../../storage/identity.js';
import { WorkspaceAccessError, type WorkspaceAuthorization } from '../workspace/authorization.js';

interface EventRecord {
  _id: string;
  id: string;
  generationId: string;
  boardId: string;
  sequence: Long;
  kind: string;
  payload: unknown;
}

export const maximumBoardEventReplay = 1_000;

export function createBoardEventStore(database: Db, generationId: string, boardId: string) {
  const events = database.collection<EventRecord>('events');
  const scope: Filter<EventRecord> = {
    generationId, boardId, $expr: { $and: [{ $eq: ['$generationId', generationId] }, { $eq: ['$boardId', boardId] }] },
  };
  return {
    async highWater() {
      const last = await events.findOne(scope, { sort: { sequence: -1 }, projection: { sequence: 1 }, promoteLongs: false });
      if (!last) return 0n;
      const sequence = decodeRank(last.sequence);
      if (sequence < 1n) throw new Error('Stored board event sequence is invalid.');
      return sequence;
    },
    async contiguous(after: bigint, through: bigint) {
      const count = through - after;
      if (count < 0n || count > BigInt(maximumBoardEventReplay)) return false;
      if (count === 0n) return true;
      const rows = await events.find({ ...scope, sequence: { $gt: encodeRank(after), $lte: encodeRank(through) } },
        { projection: { id: 1, sequence: 1 }, promoteLongs: false })
        .sort({ sequence: 1 }).limit(maximumBoardEventReplay + 1).toArray();
      return BigInt(rows.length) === count
        && rows.every(({ _id, id, sequence }, index) => publicIdSchema.safeParse(id).success && _id === workspaceKey(generationId, id)
          && Long.isLong(sequence) && !sequence.unsigned && sequence.toBigInt() === after + BigInt(index + 1));
    },
    async get(sequence: bigint) {
      const row = await events.findOne({ ...scope, sequence: encodeRank(sequence) }, { promoteLongs: false });
      if (!row || !publicIdSchema.safeParse(row.id).success || row._id !== workspaceKey(generationId, row.id)
          || !Long.isLong(row.sequence) || row.sequence.unsigned || row.sequence.toBigInt() !== sequence) return null;
      return row;
    },
  };
}

export async function projectBoardEvent(
  scope: WorkspaceAuthorization, boardId: string, { kind, payload }: EventRecord,
): Promise<BoardEventFrame> {
  const board = { boardId };
  if (kind === 'board.access-changed') return { event: kind, data: board };
  const invalidated = { event: 'board.invalidated', data: board } as const;
  if (kind !== 'card.removed' && kind !== 'card.changed' && kind !== 'card.mediaChanged') return invalidated;
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const id = publicIdSchema.safeParse(data.id);
  if (!id.success) return invalidated;
  // A transfer's source event uses the removed card's source-local ID, never its new placement.
  if (kind === 'card.removed') return { event: kind, data: { ...board, id: id.data } };
  const revision = revisionSchema.safeParse(data.revision);
  if (!revision.success) return invalidated;
  try {
    await scope.requireCard(id.data, boardId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.statusCode === 404) return invalidated;
    throw error;
  }
  return { event: kind, data: { ...board, id: id.data, revision: revision.data } };
}
