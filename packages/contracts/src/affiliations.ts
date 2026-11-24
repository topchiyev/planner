import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { boardLabelSchema, workspaceData } from './workspace.js';

export const labelColorSchema = z.enum([
  'muddy-grey', 'autumn-leafs', 'morning-sky', 'antique-blue', 'egg-yellow', 'desert-sand', 'dark-granite',
  'fresh-salad', 'lagoon-blue', 'midnight-blue', 'light-orange', 'pumpkin-orange', 'light-concrete', 'sunny-grass',
  'navy-blue', 'lilac-eyes', 'apricot-red', 'orange-peel', 'silver-glint', 'bright-moss', 'deep-ocean',
  'summer-sky', 'berry-red', 'light-cocoa', 'grey-stone', 'tank-green', 'coral-green', 'sugar-plum',
  'pink-tulip', 'shady-rust', 'wet-rock', 'wet-moss', 'turquoise-sea', 'lavender-fields', 'piggy-red',
  'light-mud', 'gun-metal', 'modern-green', 'french-coast', 'sweet-lilac', 'red-burgundy', 'pirate-gold',
]);
export type LabelColor = z.infer<typeof labelColorSchema>;

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const related = target.extend({ relatedId: publicIdSchema });
const name = z.string().trim().min(1).max(128).nullable();

const labelResult = workspaceData(z.strictObject({ label: boardLabelSchema, boardRevision: revisionSchema }));
const linkResult = workspaceData(z.strictObject({ id: publicIdSchema, revision: revisionSchema }));
const followResult = workspaceData(z.strictObject({ following: z.boolean(), revision: revisionSchema }));
const removedLink = workspaceData(z.strictObject({ parentRevision: revisionSchema.nullable() }));
export const labelDeleteReceipt = workspaceData(z.strictObject({
  id: publicIdSchema, boardId: publicIdSchema, parentRevision: revisionSchema,
}));

function affiliateCommand<const ID extends string, const Method extends 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  const Path extends string, const Status extends 200 | 201 | 204, Input extends z.ZodType, Output extends z.ZodType>(
  id: ID, method: Method, path: Path, status: Status, target: 'parent' | 'edge', input: Input, output: Output,
) {
  return { id, kind: 'command', method, path, status, target, input, output } as const;
}

export const affiliationCommands = {
  'labels.create': affiliateCommand('labels.create', 'POST', '/api/v1/boards/:id/labels', 201, 'parent',
    target.extend({ name: name.default(null), color: labelColorSchema }), labelResult),
  'labels.update': affiliateCommand('labels.update', 'PATCH', '/api/v1/labels/:id', 200, 'parent',
    target.extend({ name: name.optional(), color: labelColorSchema.optional() })
      .refine((value) => value.name !== undefined || value.color !== undefined), labelResult),
  'labels.delete': affiliateCommand('labels.delete', 'DELETE', '/api/v1/labels/:id', 204, 'parent', target, labelDeleteReceipt),
  'cards.addLabel': affiliateCommand('cards.addLabel', 'PUT', '/api/v1/cards/:id/labels/:relatedId', 200, 'parent', related, linkResult),
  'cards.removeLabel': affiliateCommand('cards.removeLabel', 'DELETE', '/api/v1/cards/:id/labels/:relatedId', 204, 'edge', related, removedLink),
  'cards.assign': affiliateCommand('cards.assign', 'PUT', '/api/v1/cards/:id/assignees/:relatedId', 200, 'parent', related, linkResult),
  'cards.unassign': affiliateCommand('cards.unassign', 'DELETE', '/api/v1/cards/:id/assignees/:relatedId', 204, 'edge', related, removedLink),
  'boards.follow': affiliateCommand('boards.follow', 'PUT', '/api/v1/boards/:id/follow', 200, 'parent', target, followResult),
  'boards.unfollow': affiliateCommand('boards.unfollow', 'DELETE', '/api/v1/boards/:id/follow', 204, 'parent', target, followResult),
  'cards.follow': affiliateCommand('cards.follow', 'PUT', '/api/v1/cards/:id/follow', 200, 'parent', target, followResult),
  'cards.unfollow': affiliateCommand('cards.unfollow', 'DELETE', '/api/v1/cards/:id/follow', 204, 'parent', target, followResult),
} as const;
