import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { transferSummary } from './transfers.js';
import { boardListSchema, finiteListKindSchema, listColorSchema, workspaceData } from './workspace.js';

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const name = z.string().trim().min(1).max(128);
const color = listColorSchema.nullable();
const receipt = workspaceData(z.strictObject({
  list: boardListSchema.omit({ cardCount: true }),
  boardRevision: revisionSchema,
  boardOrderVersion: revisionSchema,
}));

export const listLifecycleCommands = {
  'lists.create': {
    id: 'lists.create', kind: 'command', method: 'POST', path: '/api/v1/boards/:id/lists', status: 201, target: 'parent',
    input: target.extend({ name, kind: finiteListKindSchema, color: color.default(null) }),
    output: receipt,
  },
  'lists.update': {
    id: 'lists.update', kind: 'command', method: 'PATCH', path: '/api/v1/lists/:id', status: 200, target: 'parent',
    input: target.extend({ name: name.optional(), color: color.optional() })
      .refine((value) => value.name !== undefined || value.color !== undefined),
    output: receipt,
  },
  'lists.move': {
    id: 'lists.move', kind: 'command', method: 'POST', path: '/api/v1/lists/:id/move', status: 200, target: 'parent',
    input: target.extend({
      toBoardId: publicIdSchema, beforeListId: publicIdSchema.nullable(),
      sourceOrderVersion: revisionSchema, destinationOrderVersion: revisionSchema,
    }),
    output: receipt.extend({ data: receipt.shape.data.extend({
      sourceBoardRevision: revisionSchema.optional(), sourceBoardOrderVersion: revisionSchema.optional(), remaps: transferSummary.optional(),
    }) }),
  },
} as const;
