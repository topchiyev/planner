import { z } from 'zod';
import { boardPageSize, boardQueryIds, boardSearchQuery } from './board-query.js';
import { boardEventCursorSchema } from './board-events.js';
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
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const limit = boardPageSize.default(25);
const pageQuery = { limit, cursor: cursor.optional() };
const paginated = z.strictObject({ nextCursor: cursor.nullable() });
const page = <S extends z.ZodType>(item: S) => z.strictObject({ data: z.array(item), page: paginated });
const data = <S extends z.ZodType>(schema: S) => z.strictObject({ data: schema });

export { pageQuery as workspacePageQuery, page as workspacePage, data as workspaceData };

export const projectGradientSchema = z.enum(['mist', 'harbor', 'fern', 'dusk']);
export const projectBackgroundSchema = z.union([
  z.null(),
  z.strictObject({ kind: z.literal('preset'), preset: projectGradientSchema }),
  z.strictObject({ kind: z.literal('image'), id: publicIdSchema }),
]);
export type ProjectBackground = z.infer<typeof projectBackgroundSchema>;

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
  type: workspaceProjectType, hidden: z.boolean(), favorite: z.boolean(), permissions: projectAccessSchema, boardCount: nonnegative, boardOrderVersion: revisionSchema,
});
export const fieldDefinitionSchema = ordered.extend({
  fieldGroupId: publicIdSchema, showOnFront: z.boolean(), inherited: z.boolean(),
});
export const fieldGroupSchema = ordered.extend({
  scopeType: workspaceFieldScope, scopeId: publicIdSchema, localName: maybeText, linked: z.boolean(),
  orderVersion: revisionSchema, definitions: z.array(fieldDefinitionSchema),
});
export const projectDetailSchema = projectSummarySchema.extend({
  description: maybeText, boards: z.array(boardSummarySchema),
  managers: z.array(workspacePersonSchema).nullable(),
  fieldTemplates: z.array(fieldGroupSchema).nullable(),
  fieldGroupOrderVersion: revisionSchema.nullable(),
  background: projectBackgroundSchema, backgrounds: z.array(named).nullable(),
});
export const finiteListKindSchema = z.enum(['active', 'closed']);
export const listColorSchema = z.enum([
  'berry-red', 'pumpkin-orange', 'lagoon-blue', 'pink-tulip', 'light-mud',
  'orange-peel', 'bright-moss', 'antique-blue', 'dark-granite', 'turquoise-sea',
]);
export type ListColor = z.infer<typeof listColorSchema>;

export const boardListSchema = ordered.extend({
  boardId: publicIdSchema, kind: workspaceListKind, color: listColorSchema.nullable(),
  orderVersion: revisionSchema, cardCount: nonnegative,
});
export const boardLabelSchema = ordered.omit({ name: true }).extend({ boardId: publicIdSchema, name: maybeText, color: maybeText });
export const boardSettingsSchema = z.strictObject({
  defaultView: workspaceBoardView, defaultCardType: workspaceCardType.nullable(),
  restrictedCardType: workspaceCardType.nullable(), showCreator: z.boolean(), showCardAge: z.boolean(),
  showCardCount: z.boolean(), expandChecklists: z.boolean(),
});
export const boardPreferencesSchema = boardSettingsSchema.extend({ revision: revisionSchema.nullable() });
export const boardWorkspaceSchema = z.strictObject({
  board: boardSummarySchema,
  project: projectSummarySchema,
  lists: z.array(boardListSchema),
  labels: z.array(boardLabelSchema),
  fields: z.array(fieldGroupSchema),
  fieldGroupOrderVersion: revisionSchema,
  preferences: boardPreferencesSchema,
  selfMembership: z.strictObject({ revision: revisionSchema.nullable() }).nullable(),
  following: z.boolean(),
  orderVersion: revisionSchema,
  latestEventSequence: signedInt64TextSchema,
  recipeScope: z.string().regex(/^[a-f0-9]{64}$/u),
  eventCursor: boardEventCursorSchema,
});
export const cardStopwatchSchema = z.strictObject({ startedAt: nullableUtcInstantSchema, total: nonnegative }).nullable();
export type CardStopwatch = z.infer<typeof cardStopwatchSchema>;
export const cardSummarySchema = ordered.extend({
  boardId: publicIdSchema, listId: publicIdSchema, kind: workspaceCardContext, type: workspaceCardType,
  closed: z.boolean(), dueDate: nullableUtcInstantSchema, dueDateCompleted: z.boolean().nullable(), permissions: cardAccessSchema,
});
const attachmentSchema = named.extend({
  cardId: publicIdSchema, kind: z.enum(['file', 'link']), available: z.boolean(), hasThumbnail: z.boolean(), byteLength: nonnegative.nullable(), url: maybeText,
});
export const cardDetailSchema = cardSummarySchema.extend({
  description: maybeText, stopwatch: cardStopwatchSchema, checklistOrderVersion: revisionSchema, previousListId: maybeId, labels: z.array(boardLabelSchema),
  assignees: z.array(workspacePersonSchema), following: z.boolean(), automaticFollow: z.boolean(), attachments: z.array(attachmentSchema), coverAttachmentId: maybeId,
  fields: z.array(fieldGroupSchema),
  fieldGroupOrderVersion: revisionSchema,
  values: z.array(z.strictObject({ fieldGroupId: publicIdSchema, fieldDefinitionId: publicIdSchema, value: z.string() })),
});
const task = entity.extend({ checklistId: publicIdSchema, rank: signedInt64TextSchema.nullable() });
export const taskProjection = z.discriminatedUnion('kind', [
  task.extend({ kind: z.literal('task'), name: z.string(), completed: z.boolean(), assignee: workspacePersonSchema.nullable() }),
  task.extend({ kind: z.literal('linked'), linkedCard: z.strictObject({ id: publicIdSchema, name: z.string(), boardId: publicIdSchema,
    completed: z.boolean() }), assignee: workspacePersonSchema.nullable() }),
  task.extend({ kind: z.literal('unavailable') }),
]);
export const checklistSchema = ordered.extend({
  cardId: publicIdSchema, showOnFront: z.boolean(), hideCompleted: z.boolean(), orderVersion: revisionSchema, tasks: z.array(taskProjection),
});
const frontChecklistSchema = checklistSchema.extend({ tasks: z.array(taskProjection).max(5) });
export const commentSchema = entity.extend({
  cardId: publicIdSchema, text: z.string(), author: workspacePersonSchema.nullable(),
  permissions: z.strictObject({ canEdit: z.boolean(), canDelete: z.boolean() }),
});

export const workspaceActivityKind = z.enum(['createCard', 'moveCard', 'assignCard', 'unassignCard', 'completeTask', 'uncompleteTask']);
export const workspaceNotificationKind = z.enum(['moveCard', 'assignCard', 'commentCard', 'mentionInComment']);
const feedCard = z.strictObject({ id: publicIdSchema, boardId: publicIdSchema, kind: workspaceCardContext, name: z.string() });
const activityItem = entity.omit({ revision: true }).extend({
  kind: workspaceActivityKind, card: feedCard, actor: workspacePersonSchema.nullable(),
});
const notificationItem = entity.extend({
  revision: revisionSchema.nullable(), kind: workspaceNotificationKind, card: feedCard,
  actor: workspacePersonSchema.nullable(), readAt: nullableUtcInstantSchema,
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
    context: workspaceCardContext.default('board'), q: boardSearchQuery.default(''),
    labelsAny: boardQueryIds.default([]), labelsNone: boardQueryIds.default([]), members: boardQueryIds.default([]),
    listIds: boardQueryIds.default([]), unassigned: queryBoolean.default(false), ...pageQuery,
  }), page(cardSummarySchema.extend({ cover: z.strictObject({ attachmentId: publicIdSchema, hasThumbnail: z.boolean() }).nullable(), frontChecklists: z.array(frontChecklistSchema).max(3), frontFields: z.array(z.strictObject({
    fieldGroupId: publicIdSchema, fieldDefinitionId: publicIdSchema, name: z.string(), value: z.string(),
  })) })).extend({
    counts: z.array(z.strictObject({ listId: publicIdSchema, count: nonnegative })),
    searchValidation: z.enum(['ok', 'invalid-pattern', 'search-limit']),
  })),
  cardGet: read('cards.get', '/api/v1/cards/:id', identifier.extend({ boardId: publicIdSchema.optional() }), data(cardDetailSchema)),
  boardLabels: read('labels.list', '/api/v1/boards/:id/labels', identifier, data(z.array(boardLabelSchema))),
  cardChecklists: read('checklists.list', '/api/v1/cards/:id/checklists', identifier.extend({ boardId: publicIdSchema.optional() }), data(z.array(checklistSchema))),
  cardComments: read('comments.list', '/api/v1/cards/:id/comments', identifier.extend({ ...pageQuery, boardId: publicIdSchema.optional() }), page(commentSchema)),
  boardActivity: read('activity.board', '/api/v1/boards/:id/activity', identifier.extend(pageQuery), page(activityItem)),
  cardActivity: read('activity.card', '/api/v1/cards/:id/activity', identifier.extend({ ...pageQuery, boardId: publicIdSchema.optional() }), page(activityItem)),
  notificationsList: read('notifications.list', '/api/v1/notifications', z.strictObject({
    ...pageQuery, unread: queryBoolean.default(false),
  }), page(notificationItem).extend({ unreadCount: nonnegative })),
} as const;

export type WorkspaceReadOperation = keyof typeof workspaceOperations;
export type WorkspaceReadInput<K extends WorkspaceReadOperation> = z.infer<(typeof workspaceOperations)[K]['input']>;
export type WorkspaceReadOutput<K extends WorkspaceReadOperation> = z.infer<(typeof workspaceOperations)[K]['output']>;
export type ProjectAccess = z.infer<typeof projectAccessSchema>;
export type BoardAccess = z.infer<typeof boardAccessSchema>;
export type CardAccess = z.infer<typeof cardAccessSchema>;
