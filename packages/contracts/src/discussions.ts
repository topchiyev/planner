import { z } from 'zod';
import { nullableUtcInstantSchema, publicIdSchema, revisionSchema } from './storage.js';
import { workspaceData } from './workspace.js';

export const maximumCommentLength = 8_000;
const commentText = z.string().max(maximumCommentLength).refine((value) => value.trim().length > 0 && !value.includes('\0'));
const identified = z.strictObject({ id: publicIdSchema });
const target = identified.extend({ expectedRevision: revisionSchema });
const savedComment = workspaceData(identified.extend({ revision: revisionSchema, cardRevision: revisionSchema }));
const readAcknowledgement = workspaceData(z.strictObject({ acknowledged: z.literal(true) }));

export const removedComment = workspaceData(identified.extend({
  cardId: publicIdSchema, cardRevision: revisionSchema, authoredByActor: z.boolean(),
}));

export const discussionCommands = {
  'comments.create': {
    id: 'comments.create', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/comments', status: 201, target: 'parent',
    input: target.extend({ text: commentText }), output: savedComment,
  },
  'comments.update': {
    id: 'comments.update', kind: 'command', method: 'PATCH', path: '/api/v1/comments/:id', status: 200, target: 'parent',
    input: target.extend({ text: commentText }), output: savedComment,
  },
  'comments.delete': {
    id: 'comments.delete', kind: 'command', method: 'DELETE', path: '/api/v1/comments/:id', status: 204, target: 'parent',
    input: target, output: removedComment,
  },
  'notifications.update': {
    id: 'notifications.update', kind: 'command', method: 'PATCH', path: '/api/v1/notifications/:id', status: 200, target: 'edge',
    input: identified.extend({ expectedRevision: revisionSchema.nullable(), read: z.boolean() }),
    output: workspaceData(identified.extend({ revision: revisionSchema.nullable(), readAt: nullableUtcInstantSchema })),
  },
  'notifications.readAll': {
    id: 'notifications.readAll', kind: 'command', method: 'POST', path: '/api/v1/notifications/read-all', status: 200, target: 'unversioned',
    input: z.strictObject({}), output: readAcknowledgement,
  },
  'notifications.readCard': {
    id: 'notifications.readCard', kind: 'command', method: 'POST', path: '/api/v1/cards/:id/notifications/read', status: 200, target: 'unversioned',
    input: identified, output: readAcknowledgement,
  },
} as const;

export function mentionTokens(text: string) {
  const pattern = /@\[((?:[^\[\]\\\r\n]|\\[\[\]\\])+)\]\(([^)\r\n]{1,36})\)/gu;
  return [...text.matchAll(pattern)].flatMap((match) => {
    const start = match.index;
    let escape = start;
    while (escape > 0 && text[escape - 1] === '\\') escape--;
    if ((start - escape) % 2 !== 0) return [];
    const end = start + match[0].length;
    return [{ identifier: match[2], identifierStart: end - match[2].length - 1,
      start, end, label: match[1].replace(/\\([\[\]\\])/gu, '$1') }];
  });
}

export function commentMentions(text: string) {
  return mentionTokens(text).flatMap(({ identifier, start, end, label }) => {
    const id = publicIdSchema.safeParse(identifier);
    return id.success ? [{ id: id.data, start, end, label }] : [];
  });
}
