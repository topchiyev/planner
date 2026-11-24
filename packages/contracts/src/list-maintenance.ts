import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { workspaceData } from './workspace.js';

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const position = z.strictObject({ listId: publicIdSchema, revision: revisionSchema, orderVersion: revisionSchema });
const count = z.number().safe().int().nonnegative();
export const listSortFields = z.enum(['name', 'dueDate', 'createdAt']);
export const listSortDirections = z.enum(['asc', 'desc']);

export const listMaintenanceCommands = {
  'lists.sort': {
    id: 'lists.sort', kind: 'command', method: 'POST', path: '/api/v1/lists/:id/sort', status: 200, target: 'parent',
    input: target.extend({ field: listSortFields, direction: listSortDirections, sourceOrderVersion: revisionSchema }),
    output: workspaceData(z.strictObject({ source: position, changedCount: count })),
  },
  'lists.archiveCards': {
    id: 'lists.archiveCards', kind: 'command', method: 'POST', path: '/api/v1/lists/:id/archive-cards', status: 200, target: 'parent',
    input: target.extend({ sourceOrderVersion: revisionSchema, archiveListId: publicIdSchema, destinationOrderVersion: revisionSchema }),
    output: workspaceData(z.strictObject({ source: position, destination: position, archivedCount: count })),
  },
  'lists.clearTrash': {
    id: 'lists.clearTrash', kind: 'command', method: 'POST', path: '/api/v1/boards/:id/trash/clear', status: 200, target: 'parent',
    input: target.extend({ trashListId: publicIdSchema, trashOrderVersion: revisionSchema, confirmed: z.literal(true) }),
    output: workspaceData(z.strictObject({ trash: position, clearedCount: count })),
  },
} as const;
