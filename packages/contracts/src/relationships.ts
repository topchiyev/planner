import { fieldCommands, fieldTemplateOptionSchema } from './custom-fields.js';
import { z } from 'zod';
import { affiliationCommands } from './affiliations.js';
import { cardTransitionCommands } from './card-transitions.js';
import { cardLifecycleCommands } from './card-lifecycle.js';
import { boardLifecycleCommands } from './board-lifecycle.js';
import { discussionCommands } from './discussions.js';
import { checklistCommands } from './checklists.js';
import { listMaintenanceCommands } from './list-maintenance.js';
import { listLifecycleCommands } from './list-lifecycle.js';
import { publicIdSchema, revisionSchema } from './storage.js';
import { projectBackgroundSchema, workspaceData, workspacePage, workspacePageQuery, workspacePersonSchema, workspaceProjectType } from './workspace.js';

const id = z.strictObject({ id: publicIdSchema });
const target = id.extend({ userId: publicIdSchema });
const edgeRevision = revisionSchema.nullable();
const requiredRevision = target.extend({ expectedRevision: edgeRevision });
const parentRevision = target.extend({ expectedRevision: revisionSchema });
const role = z.enum(['editor', 'viewer']);

const projectRevision = id.extend({ expectedRevision: revisionSchema });
const changedFavorite = workspaceData(projectRevision.omit({ expectedRevision: true }).extend({ revision: revisionSchema, favorite: z.boolean() }));

const projectName = z.string().trim().min(1).max(128);
const projectDescription = z.string().max(8000).nullable();
const projectCreate = z.strictObject({ name: projectName, description: projectDescription.default(null), type: workspaceProjectType });
const projectDelete = projectRevision.extend({ name: z.string() });
const projectUpdate = id.extend({
  expectedRevision: revisionSchema,
  name: projectName.optional(),
  description: projectDescription.optional(),
  hidden: z.boolean().optional(),
  type: workspaceProjectType.optional(),
  background: projectBackgroundSchema.optional(),
}).refine(({ name, description, hidden, type, background }) => [name, description, hidden, type, background].some((value) => value !== undefined));

const boardMemberAdd = parentRevision.extend({ role, canComment: z.boolean().nullable().optional() })
  .refine((value) => value.role === 'viewer' ? value.canComment !== null : typeof value.canComment !== 'boolean')
  .transform((value) => ({ ...value, canComment: value.role === 'editor' ? null : value.canComment ?? false }));

const boardMemberUpdate = requiredRevision.extend({ role: role.optional(), canComment: z.boolean().nullable().optional() })
  .refine((value) => value.role !== undefined || value.canComment !== undefined);

export const relationshipParentRevisionHeader = 'planner-parent-revision';
export const removedRelationship = workspaceData(z.strictObject({ parentRevision: revisionSchema.nullable() }));
export const relationshipBoardInvalidation = z.strictObject({
  boardId: publicIdSchema, kind: z.literal('board.access-changed'), payload: z.strictObject({}),
});
export type RelationshipBoardInvalidation = z.infer<typeof relationshipBoardInvalidation>;
const changedProject = workspaceData(z.union([
  z.strictObject({
    id: publicIdSchema, name: z.string(), description: z.string().nullable(), type: workspaceProjectType,
    hidden: z.boolean(), revision: revisionSchema,
  }),
  id.extend({ applied: z.literal(true) }),
]));
const changedEdge = target.extend({ revision: revisionSchema, parentRevision: revisionSchema });
const addedManager = workspaceData(changedEdge.extend({ projectId: publicIdSchema }));
const changedMember = workspaceData(changedEdge.extend({ boardId: publicIdSchema, role, canComment: z.boolean().nullable() }));
const manager = z.strictObject({
  id: publicIdSchema, userId: publicIdSchema, revision: edgeRevision, person: workspacePersonSchema.nullable(),
});
const member = manager.extend({ role, canComment: z.boolean().nullable() });
const rosterInput = id.extend(workspacePageQuery);
const candidatesInput = rosterInput.extend({ q: z.string().trim().max(120).default('') });

function command<const ID extends string, const Route extends string, const Method extends 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  const Status extends 200 | 201 | 204, I extends z.ZodType, O extends z.ZodType>(
  id: ID, method: Method, path: Route, status: Status, target: 'parent' | 'edge' | 'create', input: I, output: O,
) {
  return { id, kind: 'command', method, path, status, target, input, output } as const;
}

function read<const ID extends string, const Route extends string, I extends z.ZodType, O extends z.ZodType>(
  id: ID, path: Route, input: I, output: O,
) {
  return { id, kind: 'read', method: 'GET', path, input, output } as const;
}

export const relationshipCommands = {
  ...checklistCommands,
  ...discussionCommands,
  ...fieldCommands,
  ...affiliationCommands,
  ...listMaintenanceCommands,
  ...cardLifecycleCommands,
  ...cardTransitionCommands,
  ...boardLifecycleCommands,
  ...listLifecycleCommands,
  'projects.create': command('projects.create', 'POST', '/api/v1/projects', 201, 'create', projectCreate, workspaceData(id)),
  'projects.delete': command('projects.delete', 'DELETE', '/api/v1/projects/:id', 204, 'parent', projectDelete, workspaceData(id)),
  'projects.favorite': command('projects.favorite', 'PUT', '/api/v1/projects/:id/favorite', 200, 'parent', projectRevision, changedFavorite),
  'projects.unfavorite': command('projects.unfavorite', 'DELETE', '/api/v1/projects/:id/favorite', 204, 'parent', projectRevision, changedFavorite),
  'projects.update': command('projects.update', 'PATCH', '/api/v1/projects/:id', 200, 'parent', projectUpdate, changedProject),
  'projects.addManager': command('projects.addManager', 'POST', '/api/v1/projects/:id/managers', 201, 'parent', parentRevision, addedManager),
  'projects.removeManager': command('projects.removeManager', 'DELETE', '/api/v1/projects/:id/managers/:userId', 204, 'edge',
    requiredRevision, removedRelationship),
  'boards.addMember': command('boards.addMember', 'POST', '/api/v1/boards/:id/members', 201, 'parent', boardMemberAdd, changedMember),
  'boards.updateMember': command('boards.updateMember', 'PATCH', '/api/v1/boards/:id/members/:userId', 200, 'edge', boardMemberUpdate, changedMember),
  'boards.removeMember': command('boards.removeMember', 'DELETE', '/api/v1/boards/:id/members/:userId', 204, 'edge',
    requiredRevision, removedRelationship),
} as const;

export const relationshipReads = {
  'boards.transferDestinations': read('boards.transferDestinations', '/api/v1/boards/:id/transfer-destinations', candidatesInput,
    workspacePage(id.extend({ name: z.string(), project: id.extend({ name: z.string() }) }))),
  'fields.templateOptions': read('fields.templateOptions', '/api/v1/boards/:id/field-template-options', rosterInput, workspacePage(fieldTemplateOptionSchema)),
  'projects.managers': read('projects.managers', '/api/v1/projects/:id/managers', rosterInput, workspacePage(manager)),
  'projects.managerCandidates': read('projects.managerCandidates', '/api/v1/projects/:id/manager-candidates', candidatesInput,
    workspacePage(workspacePersonSchema)),
  'boards.members': read('boards.members', '/api/v1/boards/:id/members', rosterInput, workspacePage(member)),
  'boards.filterMembers': read('boards.filterMembers', '/api/v1/boards/:id/filter-members', candidatesInput,
    workspacePage(workspacePersonSchema)),
  'boards.mentionMembers': read('boards.mentionMembers', '/api/v1/boards/:id/mention-members', candidatesInput,
    workspacePage(workspacePersonSchema)),
  'boards.memberCandidates': read('boards.memberCandidates', '/api/v1/boards/:id/member-candidates', candidatesInput,
    workspacePage(workspacePersonSchema)),
} as const;

export type RelationshipCommand = keyof typeof relationshipCommands;
export type RelationshipRead = keyof typeof relationshipReads;
export type RelationshipCommandInput<K extends RelationshipCommand> = z.infer<(typeof relationshipCommands)[K]['input']>;
export type RelationshipCommandOutput<K extends RelationshipCommand> = z.infer<(typeof relationshipCommands)[K]['output']>;
export type RelationshipReadInput<K extends RelationshipRead> = z.infer<(typeof relationshipReads)[K]['input']>;
export type RelationshipReadOutput<K extends RelationshipRead> = z.infer<(typeof relationshipReads)[K]['output']>;
