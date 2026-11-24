import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { boardPreferencesSchema, boardSettingsSchema, boardSummarySchema, workspaceData } from './workspace.js';

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const title = z.string().trim().min(1).max(128);
const orderReceipt = workspaceData(z.strictObject({
  board: boardSummarySchema,
  projectRevision: revisionSchema,
  projectBoardOrderVersion: revisionSchema,
}));
const settingsReceipt = workspaceData(z.strictObject({ board: boardSummarySchema, preferences: boardPreferencesSchema }));

export const boardDeleteReceipt = workspaceData(z.strictObject({
  projectId: publicIdSchema,
  parentRevision: revisionSchema,
}));

export const boardLifecycleCommands = {
  'boards.create': {
    id: 'boards.create', kind: 'command', method: 'POST', path: '/api/v1/projects/:id/boards', status: 201, target: 'parent',
    input: target.extend({ name: title }),
    output: orderReceipt,
  },
  'boards.move': {
    id: 'boards.move', kind: 'command', method: 'POST', path: '/api/v1/boards/:id/move', status: 200, target: 'parent',
    input: target.extend({ beforeBoardId: publicIdSchema.nullable(), projectBoardOrderVersion: revisionSchema }),
    output: orderReceipt,
  },
  'boards.update': {
    id: 'boards.update', kind: 'command', method: 'PATCH', path: '/api/v1/boards/:id', status: 200, target: 'parent',
    input: target.extend({ ...boardSettingsSchema.partial().shape, name: title.optional() })
      .refine(({ id: _id, expectedRevision: _revision, ...values }) => Object.values(values).some((value) => value !== undefined)),
    output: settingsReceipt,
  },
  'boards.delete': {
    id: 'boards.delete', kind: 'command', method: 'DELETE', path: '/api/v1/boards/:id', status: 204, target: 'parent',
    input: target.extend({ name: z.string().min(1) }),
    output: boardDeleteReceipt,
  },
} as const;

export type BoardLifecycleOperation = keyof typeof boardLifecycleCommands;
