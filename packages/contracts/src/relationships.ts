import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { workspaceData, workspacePage, workspacePageQuery, workspacePersonSchema, workspaceProjectType } from './workspace.js';

const id = z.strictObject({ id: publicIdSchema });
const target = id.extend({ userId: publicIdSchema });
const edgeRevision = revisionSchema.nullable();
const requiredRevision = target.extend({ revision: edgeRevision });
const role = z.enum(['editor', 'viewer']);

const projectUpdate = id.extend({
  revision: revisionSchema,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(8000).nullable().optional(),
  hidden: z.boolean().optional(),
  type: workspaceProjectType.optional(),
}).refine(({ name, description, hidden, type }) => [name, description, hidden, type].some((value) => value !== undefined));

const boardMemberAdd = target.extend({ role, canComment: z.boolean().nullable().optional() })
  .refine((value) => value.role === 'viewer' ? value.canComment !== null : typeof value.canComment !== 'boolean')
  .transform((value) => ({ ...value, canComment: value.role === 'editor' ? null : value.canComment ?? false }));

const boardMemberUpdate = requiredRevision.extend({ role: role.optional(), canComment: z.boolean().nullable().optional() })
  .refine((value) => value.role !== undefined || value.canComment !== undefined);

const identity = workspaceData(z.strictObject({ id: publicIdSchema }));
const changed = workspaceData(z.strictObject({ id: publicIdSchema, revision: revisionSchema }));
const manager = z.strictObject({
  id: publicIdSchema, userId: publicIdSchema, revision: edgeRevision, person: workspacePersonSchema.nullable(),
});
const member = manager.extend({ role, canComment: z.boolean().nullable() });
const rosterInput = id.extend(workspacePageQuery);
const candidatesInput = rosterInput.extend({ q: z.string().trim().max(120).default('') });

function command<const ID extends string, const Route extends string, const Method extends 'POST' | 'PATCH' | 'DELETE',
  I extends z.ZodType, O extends z.ZodType>(id: ID, method: Method, path: Route, input: I, output: O) {
  return { id, kind: 'command', method, path, input, output } as const;
}

function read<const ID extends string, const Route extends string, I extends z.ZodType, O extends z.ZodType>(
  id: ID, path: Route, input: I, output: O,
) {
  return { id, kind: 'read', method: 'GET', path, input, output } as const;
}

export const relationshipCommands = {
  'projects.update': command('projects.update', 'PATCH', '/api/v1/projects/:id', projectUpdate, changed),
  'projects.addManager': command('projects.addManager', 'POST', '/api/v1/projects/:id/managers', target, changed),
  'projects.removeManager': command('projects.removeManager', 'DELETE', '/api/v1/projects/:id/managers/:userId', requiredRevision, identity),
  'boards.addMember': command('boards.addMember', 'POST', '/api/v1/boards/:id/members', boardMemberAdd, changed),
  'boards.updateMember': command('boards.updateMember', 'PATCH', '/api/v1/boards/:id/members/:userId', boardMemberUpdate, changed),
  'boards.removeMember': command('boards.removeMember', 'DELETE', '/api/v1/boards/:id/members/:userId', requiredRevision, identity),
} as const;

export const relationshipReads = {
  'projects.managers': read('projects.managers', '/api/v1/projects/:id/managers', rosterInput, workspacePage(manager)),
  'projects.managerCandidates': read('projects.managerCandidates', '/api/v1/projects/:id/manager-candidates', candidatesInput,
    workspacePage(workspacePersonSchema)),
  'boards.members': read('boards.members', '/api/v1/boards/:id/members', rosterInput, workspacePage(member)),
  'boards.memberCandidates': read('boards.memberCandidates', '/api/v1/boards/:id/member-candidates', candidatesInput,
    workspacePage(workspacePersonSchema)),
} as const;

export type RelationshipCommand = keyof typeof relationshipCommands;
export type RelationshipRead = keyof typeof relationshipReads;
export type RelationshipCommandInput<K extends RelationshipCommand> = z.infer<(typeof relationshipCommands)[K]['input']>;
export type RelationshipCommandOutput<K extends RelationshipCommand> = z.infer<(typeof relationshipCommands)[K]['output']>;
export type RelationshipReadInput<K extends RelationshipRead> = z.infer<(typeof relationshipReads)[K]['input']>;
export type RelationshipReadOutput<K extends RelationshipRead> = z.infer<(typeof relationshipReads)[K]['output']>;
