import { z } from 'zod';
import { publicIdSchema, revisionSchema, nullableUtcInstantSchema } from './storage.js';
import { cardStopwatchSchema, cardSummarySchema, workspaceCardType, workspaceData } from './workspace.js';

export const maximumCardDescriptionLength = 8_000;
export const cardDescriptionWriteSchema = z.string().max(maximumCardDescriptionLength).refine((value) => !value.includes('\0')).nullable();

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const title = z.string().trim().min(1).max(128);
const stopwatchAction = z.enum(['start', 'stop', 'reset']);

export const cardLifecycleCommands = {
  'cards.create': {
    id: 'cards.create', kind: 'command', method: 'POST', path: '/api/v1/lists/:id/cards', status: 201, target: 'parent',
    input: target.extend({
      name: title, type: workspaceCardType.optional(), description: cardDescriptionWriteSchema.default(null),
      beforeCardId: publicIdSchema.nullable().default(null),
    }),
    output: workspaceData(z.strictObject({ card: cardSummarySchema, listRevision: revisionSchema, listOrderVersion: revisionSchema })),
  },
  'cards.update': {
    id: 'cards.update', kind: 'command', method: 'PATCH', path: '/api/v1/cards/:id', status: 200, target: 'parent',
    input: target.extend({
      name: title.optional(), type: workspaceCardType.optional(), description: cardDescriptionWriteSchema.optional(),
      dueDate: nullableUtcInstantSchema.optional(), dueDateCompleted: z.boolean().optional(), closed: z.boolean().optional(),
      stopwatchAction: stopwatchAction.optional(), coverAttachmentId: publicIdSchema.nullable().optional(),
    }).refine(({ id: _id, expectedRevision: _revision, ...values }) => Object.values(values).some((value) => value !== undefined)),
    output: workspaceData(z.strictObject({
      card: cardSummarySchema, stopwatch: cardStopwatchSchema, coverAttachmentId: publicIdSchema.nullable(),
    })),
  },
} as const;

export function cardMentionToken(person: { id: string; name: string; username: string | null }) {
  const display = (person.username || person.name).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[\\[\]]/gu, '\\$&');
  return `@[${display}](${publicIdSchema.parse(person.id)})`;
}
