import { workspaceListKind } from '@planner/contracts';
import { signedInt64TextSchema } from '@planner/contracts/storage';
import { z } from 'zod';
import type { SourceRow } from './source-projections.js';

const named = z.strictObject({ name: z.string() });
const cardSnapshot = named.extend({ id: signedInt64TextSchema.optional() });
const namedSource = named.extend({ id: signedInt64TextSchema });
const listSnapshot = z.strictObject({ id: signedInt64TextSchema, name: z.string().nullable(), type: workspaceListKind });
const created = z.strictObject({ card: cardSnapshot, list: listSnapshot });
const moved = z.strictObject({ card: cardSnapshot.optional(), fromList: listSnapshot, toList: listSnapshot });
const assigned = z.strictObject({ card: cardSnapshot, user: namedSource });
const completed = z.strictObject({ card: cardSnapshot, task: namedSource });
const commented = z.strictObject({ card: cardSnapshot, text: z.string() });

const actionSchemas = {
  createCard: { kind: 'createCard', snapshot: created },
  moveCard: { kind: 'moveCard', snapshot: moved },
  addMemberToCard: { kind: 'assignCard', snapshot: assigned },
  removeMemberFromCard: { kind: 'unassignCard', snapshot: assigned },
  completeTask: { kind: 'completeTask', snapshot: completed },
  uncompleteTask: { kind: 'uncompleteTask', snapshot: completed },
} as const;

const noticeSchemas = {
  moveCard: actionSchemas.moveCard,
  addMemberToCard: actionSchemas.addMemberToCard,
  commentCard: { kind: 'commentCard', snapshot: commented },
  mentionInComment: { kind: 'mentionInComment', snapshot: commented },
} as const;

type SourceSchema = { kind: string; snapshot: z.ZodType<{ card?: { id?: string } }> };
type HistoricalSnapshot<S extends Record<string, SourceSchema>> = {
  [K in keyof S]: { kind: S[K]['kind']; snapshot: z.infer<S[K]['snapshot']> }
}[keyof S];

type Decoded<S extends Record<string, SourceSchema>> = { data: HistoricalSnapshot<S>; reason?: never }
  | { data?: never; reason: 'unsupported-kind' | 'invalid-snapshot' };

function decode<S extends Record<string, SourceSchema>>(
  schemas: S, row: Pick<SourceRow<'action' | 'notification'>, 'type' | 'data' | 'card_id'>,
): Decoded<S> {
  if (!Object.hasOwn(schemas, row.type)) return { reason: 'unsupported-kind' };
  const schema = schemas[row.type];
  const parsed = schema.snapshot.safeParse(row.data.value);
  if (!parsed.success || (parsed.data.card?.id !== undefined && parsed.data.card.id !== row.card_id)) {
    return { reason: 'invalid-snapshot' };
  }
  return { data: { kind: schema.kind, snapshot: parsed.data } as HistoricalSnapshot<S> };
}

export const decodeActivitySnapshot = (row: SourceRow<'action'>) => decode(actionSchemas, row);
export const decodeNoticeSnapshot = (row: SourceRow<'notification'>) => decode(noticeSchemas, row);
export type ImportedActivitySnapshot = HistoricalSnapshot<typeof actionSchemas>;
export type ImportedNoticeSnapshot = HistoricalSnapshot<typeof noticeSchemas>;
