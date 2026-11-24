import { z } from 'zod';
import { nullableUtcInstantSchema, publicIdSchema, revisionSchema, signedInt64TextSchema, utcInstantSchema } from './storage.js';

export const workspaceProjectType = z.enum(['private', 'shared']);
export const workspaceListKind = z.enum(['active', 'closed', 'archive', 'trash']);
export const workspaceCardContext = z.enum(['board', 'archive', 'trash']);
export const workspaceCardType = z.enum(['project', 'story']);
export const workspaceBoardView = z.enum(['kanban', 'grid', 'list']);
export const workspaceFieldScope = z.enum(['project', 'board', 'card']);
const instantFields = { id: publicIdSchema, revision: revisionSchema, createdAt: utcInstantSchema, updatedAt: nullableUtcInstantSchema };
const entity = z.strictObject(instantFields);
const named = entity.extend({ name: z.string() });
const ordered = named.extend({ rank: signedInt64TextSchema.nullable() });
const maybeId = publicIdSchema.nullable();
const maybeText = z.string().nullable();
const nonnegative = z.number().safe().int().nonnegative();
const cursor = z.string().regex(/^v1\.[A-Za-z0-9_-]+$/u).max(2048);
const idList = z.union([publicIdSchema, z.array(publicIdSchema).max(50)])
  .transform((value) => [...new Set(typeof value === 'string' ? [value] : value)].sort());
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const limit = z.string().regex(/^[1-9]\d{0,8}$/u).transform((value) => Math.min(Number(value), 100)).default(25);
const pageQuery = { limit, cursor: cursor.optional() };
const paginated = z.strictObject({ nextCursor: cursor.nullable() });
const page = <S extends z.ZodType>(item: S) => z.strictObject({ data: z.array(item), page: paginated });
const data = <S extends z.ZodType>(schema: S) => z.strictObject({ data: schema });

export { pageQuery as workspacePageQuery, page as workspacePage, data as workspaceData };

export const projectAccessSchema = z.strictObject({
  canEdit: z.boolean(), canToggleHidden: z.boolean(), canChangeOwnership: z.boolean(), canCreateBoard: z.boolean(),
  canManageManagers: z.boolean(), canDelete: z.boolean(), canFavorite: z.boolean(),
});
export const boardAccessSchema = z.strictObject({
  canManage: z.boolean(), canEdit: z.boolean(), canComment: z.boolean(), canFollow: z.boolean(),
  canDuplicateFrom: z.boolean(), canClearTrash: z.boolean(),
});
export const cardAccessSchema = z.strictObject({
  canEdit: z.boolean(), canComment: z.boolean(), canFollow: z.boolean(), canDuplicateFrom: z.boolean(),
  canMove: z.boolean(), canArchive: z.boolean(), canTrash: z.boolean(), canRestore: z.boolean(), canPurge: z.boolean(),
});
export const workspacePersonSchema = z.strictObject({ id: publicIdSchema, name: z.string(), username: maybeText });
export const boardSummarySchema = ordered.extend({ projectId: publicIdSchema, permissions: boardAccessSchema });
export const projectSummarySchema = ordered.extend({
  type: workspaceProjectType, hidden: z.boolean(), favorite: z.boolean(), permissions: projectAccessSchema, boardCount: nonnegative,
});
export const fieldDefinitionSchema = ordered.extend({ fieldGroupId: publicIdSchema, showOnFront: z.boolean() });
export const fieldGroupSchema = ordered.extend({
  scopeType: workspaceFieldScope, scopeId: publicIdSchema, definitions: z.array(fieldDefinitionSchema),
});
export const projectDetailSchema = projectSummarySchema.extend({
  description: maybeText, boards: z.array(boardSummarySchema),
  managers: z.array(workspacePersonSchema).nullable(),
  fieldTemplates: z.array(fieldGroupSchema).nullable(),
  backgrounds: z.array(named).nullable(),
});
export const boardListSchema = ordered.extend({
  boardId: publicIdSchema, kind: workspaceListKind, orderVersion: revisionSchema, cardCount: nonnegative,
});
export const boardLabelSchema = ordered.omit({ name: true }).extend({ boardId: publicIdSchema, name: maybeText, color: maybeText });
export const boardPreferencesSchema = z.strictObject({
  revision: revisionSchema.nullable(), defaultView: workspaceBoardView, defaultCardType: workspaceCardType.nullable(),
  restrictedCardType: workspaceCardType.nullable(), showCreator: z.boolean(), showCardAge: z.boolean(),
  showCardCount: z.boolean(), expandChecklists: z.boolean(),
});
export const boardWorkspaceSchema = z.strictObject({
  board: boardSummarySchema,
  project: projectSummarySchema,
  lists: z.array(boardListSchema),
  labels: z.array(boardLabelSchema),
  preferences: boardPreferencesSchema,
  orderVersion: revisionSchema,
  latestEventSequence: signedInt64TextSchema,
});
export const cardSummarySchema = ordered.extend({
  boardId: publicIdSchema, listId: publicIdSchema, kind: workspaceCardContext, type: workspaceCardType,
  closed: z.boolean(), dueDate: nullableUtcInstantSchema, permissions: cardAccessSchema,
});
const attachmentSchema = named.extend({
  cardId: publicIdSchema, kind: z.enum(['file', 'link']), available: z.boolean(), byteLength: nonnegative.nullable(), url: maybeText,
});
export const cardDetailSchema = cardSummarySchema.extend({
  description: maybeText, previousListId: maybeId, labels: z.array(boardLabelSchema),
  assignees: z.array(workspacePersonSchema), attachments: z.array(attachmentSchema), coverAttachmentId: maybeId,
  fields: z.array(fieldGroupSchema),
  values: z.array(z.strictObject({ fieldGroupId: publicIdSchema, fieldDefinitionId: publicIdSchema, value: z.string() })),
});
const task = entity.extend({ checklistId: publicIdSchema, rank: signedInt64TextSchema.nullable() });
const taskProjection = z.discriminatedUnion('kind', [
  task.extend({ kind: z.literal('task'), name: z.string(), completed: z.boolean(), assignee: workspacePersonSchema.nullable() }),
  task.extend({ kind: z.literal('linked'), linkedCard: z.strictObject({ id: publicIdSchema, name: z.string(), boardId: publicIdSchema,
    completed: z.boolean() }), assignee: workspacePersonSchema.nullable() }),
  task.extend({ kind: z.literal('unavailable') }),
]);
export const checklistSchema = ordered.extend({
  cardId: publicIdSchema, showOnFront: z.boolean(), hideCompleted: z.boolean(), tasks: z.array(taskProjection),
});
export const commentSchema = entity.extend({
  cardId: publicIdSchema, text: z.string(), author: workspacePersonSchema.nullable(),
  permissions: z.strictObject({ canEdit: z.boolean(), canDelete: z.boolean() }),
});

const identifier = z.strictObject({ id: publicIdSchema });
function read<ID extends string, Route extends string, I extends z.ZodType, O extends z.ZodType>(
  id: ID, path: Route, input: I, output: O,
) {
  return { id, kind: 'read', method: 'GET', path, input, output } as const;
}

export const workspaceOperations = {
  projectsList: read('projects.list', '/api/v1/projects', z.strictObject({
    ...pageQuery, q: z.string().trim().max(256).default(''),
    hidden: z.enum(['exclude', 'include', 'only']).default('exclude'), favorite: queryBoolean.default(false),
    order: z.enum(['byDefault', 'alphabetically', 'byCreationTime']).default('byDefault'),
  }), z.strictObject({
    data: z.array(projectSummarySchema), page: paginated, permissions: z.strictObject({ canCreate: z.boolean() }),
  })),
  projectGet: read('projects.get', '/api/v1/projects/:id', identifier, data(projectDetailSchema)),
  boardsList: read('boards.list', '/api/v1/projects/:id/boards', identifier, data(z.array(boardSummarySchema))),
  boardGet: read('boards.get', '/api/v1/boards/:id', identifier, data(boardSummarySchema)),
  boardWorkspace: read('boards.workspace', '/api/v1/boards/:id/workspace', identifier, data(boardWorkspaceSchema)),
  boardCards: read('boards.cards', '/api/v1/boards/:id/cards', identifier.extend({
    context: workspaceCardContext.default('board'), q: z.string().trim().max(256).default(''),
    labelsAny: idList.default([]), labelsNone: idList.default([]), members: idList.default([]),
    listIds: idList.default([]), unassigned: queryBoolean.default(false), ...pageQuery,
  }), page(cardSummarySchema).extend({ searchValidation: z.enum(['ok', 'invalid-pattern']) })),
  cardGet: read('cards.get', '/api/v1/cards/:id', identifier, data(cardDetailSchema)),
  boardLabels: read('labels.list', '/api/v1/boards/:id/labels', identifier, data(z.array(boardLabelSchema))),
  cardChecklists: read('checklists.list', '/api/v1/cards/:id/checklists', identifier, data(z.array(checklistSchema))),
  cardComments: read('comments.list', '/api/v1/cards/:id/comments', identifier.extend(pageQuery), page(commentSchema)),
} as const;

export type WorkspaceReadOperation = keyof typeof workspaceOperations;
export type WorkspaceReadInput<K extends WorkspaceReadOperation> = z.infer<(typeof workspaceOperations)[K]['input']>;
export type WorkspaceReadOutput<K extends WorkspaceReadOperation> = z.infer<(typeof workspaceOperations)[K]['output']>;
export type ProjectAccess = z.infer<typeof projectAccessSchema>;
export type BoardAccess = z.infer<typeof boardAccessSchema>;
export type CardAccess = z.infer<typeof cardAccessSchema>;
