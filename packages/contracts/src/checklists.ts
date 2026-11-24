import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { workspaceData } from './workspace.js';

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const title = z.string().trim().min(1).max(128);
const anchor = publicIdSchema.nullable();
const localItem = z.strictObject({ id: publicIdSchema, revision: revisionSchema });
const taskPosition = z.strictObject({ checklistId: publicIdSchema, revision: revisionSchema, orderVersion: revisionSchema });

const checklistReceipt = workspaceData(z.strictObject({
  checklist: localItem, cardRevision: revisionSchema, checklistOrderVersion: revisionSchema,
}));
const taskReceipt = workspaceData(z.strictObject({
  task: localItem, checklist: taskPosition, cardRevision: revisionSchema,
}));
const taskMoveReceipt = workspaceData(z.strictObject({
  task: localItem, source: taskPosition, destination: taskPosition, cardRevision: revisionSchema,
}));
export const checklistDeleteReceipt = workspaceData(z.strictObject({
  id: publicIdSchema, cardId: publicIdSchema, parentRevision: revisionSchema, checklistOrderVersion: revisionSchema,
}));
export const taskDeleteReceipt = workspaceData(z.strictObject({
  id: publicIdSchema, cardId: publicIdSchema, checklist: taskPosition, cardRevision: revisionSchema,
}));

export const checklistCommands = {
  'checklists.create': {
    id: 'checklists.create', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/checklists', target: 'parent', status: 201,
    input: target.extend({
      name: title, showOnFront: z.boolean().default(true), hideCompleted: z.boolean().default(false), beforeChecklistId: anchor.default(null),
    }),
    output: checklistReceipt,
  },
  'checklists.update': {
    id: 'checklists.update', kind: 'command', method: 'PATCH', path: '/api/v1/checklists/:id', target: 'parent', status: 200,
    input: target.extend({
      name: title.optional(), showOnFront: z.boolean().optional(), hideCompleted: z.boolean().optional(),
      beforeChecklistId: anchor.optional(), checklistOrderVersion: revisionSchema.optional(),
    }).refine(({ name, showOnFront, hideCompleted, beforeChecklistId, checklistOrderVersion }) =>
      (beforeChecklistId === undefined) === (checklistOrderVersion === undefined)
        && [name, showOnFront, hideCompleted, beforeChecklistId].some((value) => value !== undefined)),
    output: checklistReceipt,
  },
  'checklists.delete': {
    id: 'checklists.delete', kind: 'command', method: 'DELETE', path: '/api/v1/checklists/:id', target: 'parent', status: 204,
    input: target,
    output: checklistDeleteReceipt,
  },
  'tasks.create': {
    id: 'tasks.create', kind: 'command', method: 'POST', path: '/api/v1/checklists/:id/tasks', target: 'parent', status: 201,
    input: z.union([
      target.extend({ name: title, completed: z.literal(false).default(false), assigneeId: publicIdSchema.nullable().default(null), beforeTaskId: anchor.default(null) }),
      target.extend({ linkedCardId: publicIdSchema, beforeTaskId: anchor.default(null) }),
    ]),
    output: taskReceipt,
  },
  'tasks.update': {
    id: 'tasks.update', kind: 'command', method: 'PATCH', path: '/api/v1/tasks/:id', target: 'parent', status: 200,
    input: target.extend({ name: title.optional(), completed: z.boolean().optional(), assigneeId: publicIdSchema.nullable().optional() })
      .refine(({ name, completed, assigneeId }) => [name, completed, assigneeId].some((value) => value !== undefined)),
    output: taskReceipt,
  },
  'tasks.move': {
    id: 'tasks.move', kind: 'command', method: 'POST', path: '/api/v1/tasks/:id/move', target: 'parent', status: 200,
    input: target.extend({
      toChecklistId: publicIdSchema, beforeTaskId: anchor, sourceOrderVersion: revisionSchema, destinationOrderVersion: revisionSchema,
    }),
    output: taskMoveReceipt,
  },
  'tasks.delete': {
    id: 'tasks.delete', kind: 'command', method: 'DELETE', path: '/api/v1/tasks/:id', target: 'parent', status: 204,
    input: target,
    output: taskDeleteReceipt,
  },
} as const;
