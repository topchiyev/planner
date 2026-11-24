import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { transferListPosition, transferSummary } from './transfers.js';
import { workspaceCardContext, workspaceData } from './workspace.js';

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const versions = { sourceOrderVersion: revisionSchema, destinationOrderVersion: revisionSchema };
const position = transferListPosition;
export const cardPlacementVersionsSchema = z.strictObject({ cardRevision: revisionSchema, source: position, destination: position });
export type CardPlacementVersions = z.infer<typeof cardPlacementVersionsSchema>;
const receipt = workspaceData(z.strictObject({
  card: z.strictObject({
    id: publicIdSchema, revision: revisionSchema, boardId: publicIdSchema, listId: publicIdSchema,
    kind: workspaceCardContext, closed: z.boolean(),
  }),
  source: position,
  destination: position,
  remaps: transferSummary.optional(),
}));
export const listDeleteReceipt = workspaceData(z.strictObject({
  id: publicIdSchema, boardId: publicIdSchema, parentRevision: revisionSchema,
}));

export const cardTransitionCommands = {
  'cards.move': {
    id: 'cards.move', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/move', status: 200, target: 'parent',
    input: target.extend({ ...versions, toListId: publicIdSchema, beforeCardId: publicIdSchema.nullable() }), output: receipt,
  },
  'cards.archive': {
    id: 'cards.archive', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/archive', status: 200, target: 'parent',
    input: target.extend(versions), output: receipt,
  },
  'cards.trash': {
    id: 'cards.trash', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/trash', status: 200, target: 'parent',
    input: target.extend(versions), output: receipt,
  },
  'cards.restore': {
    id: 'cards.restore', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/restore', status: 200, target: 'parent',
    input: target.extend({ ...versions, destinationOrderVersion: revisionSchema.nullable().default(null),
      toListId: publicIdSchema.nullable().default(null), beforeCardId: publicIdSchema.nullable().default(null) }), output: receipt,
  },
  'lists.delete': {
    id: 'lists.delete', kind: 'command', method: 'DELETE', path: '/api/v1/lists/:id', status: 204, target: 'parent',
    input: target.extend({ sourceOrderVersion: revisionSchema, trashOrderVersion: revisionSchema, boardOrderVersion: revisionSchema }),
    output: listDeleteReceipt,
  },
} as const;

export type CardTransition = Exclude<keyof typeof cardTransitionCommands, 'lists.delete'>;
