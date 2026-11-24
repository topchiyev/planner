import { createHmac, timingSafeEqual, type KeyObject } from 'node:crypto';
import { boardEventCursorSchema } from '@planner/contracts';
import { maximumSignedInt64 } from '@planner/contracts/storage';

export interface BoardEventScope {
  actorId: string;
  generationId: string;
  boardId: string;
}

export function createBoardEventCursors(installationKey: KeyObject) {
  const key = createHmac('sha256', installationKey).update('Planner board event cursor key v1').digest();
  const sign = ({ actorId, generationId, boardId }: BoardEventScope, sequence: string) =>
    createHmac('sha256', key).update(JSON.stringify(['v1', actorId, generationId, boardId, sequence])).digest();
  return Object.freeze({
    encode(scope: BoardEventScope, sequence: bigint) {
      if (sequence < 0n || sequence > maximumSignedInt64) throw new RangeError('Invalid board event sequence.');
      const text = sequence.toString();
      return 'v1.' + text + '.' + sign(scope, text).toString('base64url');
    },
    decode(scope: BoardEventScope, value: unknown) {
      const cursor = boardEventCursorSchema.safeParse(value);
      if (!cursor.success) return null;
      const [, sequence, mac] = cursor.data.split('.');
      const supplied = Buffer.from(mac, 'base64url');
      if (supplied.toString('base64url') !== mac || !timingSafeEqual(supplied, sign(scope, sequence))) return null;
      const next = BigInt(sequence);
      return next <= maximumSignedInt64 ? next : null;
    },
  });
}

export type BoardEventCursors = ReturnType<typeof createBoardEventCursors>;
