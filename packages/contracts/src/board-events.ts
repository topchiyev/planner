import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';

export const boardEventsPath = '/api/v1/boards/:id/events';
export const boardEventCursorSchema = z.string().regex(/^v1\.(0|[1-9]\d{0,18})\.[A-Za-z0-9_-]{43}$/u);
const board = z.strictObject({ boardId: publicIdSchema });
const card = board.extend({ id: publicIdSchema });
const changedCard = card.extend({ revision: revisionSchema });

export const boardEventFrameSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('board.access-changed'), data: board }),
  z.strictObject({ event: z.literal('board.invalidated'), data: board }),
  z.strictObject({ event: z.literal('card.removed'), data: card }),
  z.strictObject({ event: z.literal('card.changed'), data: changedCard }),
  z.strictObject({ event: z.literal('card.mediaChanged'), data: changedCard }),
  z.strictObject({ event: z.literal('reset'), data: board }),
]);
export type BoardEventFrame = z.infer<typeof boardEventFrameSchema>;
