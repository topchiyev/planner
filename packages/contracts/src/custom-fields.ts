import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';
import { fieldDefinitionSchema, fieldGroupSchema, workspaceData, workspaceFieldScope } from './workspace.js';

const target = z.strictObject({ id: publicIdSchema, expectedRevision: revisionSchema });
const name = z.string().trim().min(1).max(128);
const orderVersion = revisionSchema;
const groupPlacement = { beforeGroupId: publicIdSchema.nullable().optional(), orderVersion: orderVersion.optional() };
const definitionPlacement = { beforeFieldId: publicIdSchema.nullable().optional(), orderVersion: orderVersion.optional() };
const groupResult = workspaceData(z.strictObject({ group: fieldGroupSchema, parentRevision: revisionSchema, groupOrderVersion: revisionSchema }));
const definitionResult = workspaceData(z.strictObject({ definition: fieldDefinitionSchema, groupRevision: revisionSchema, orderVersion }));
const valueResult = workspaceData(z.strictObject({ cardId: publicIdSchema, revision: revisionSchema }));
export const fieldGroupDeleteReceipt = workspaceData(z.strictObject({
  id: publicIdSchema, scopeType: workspaceFieldScope, scopeId: publicIdSchema, parentRevision: revisionSchema,
  removedGroups: z.number().int().min(1), removedValues: z.number().int().min(0),
}));
export const fieldDefinitionDeleteReceipt = workspaceData(z.strictObject({ id: publicIdSchema, groupId: publicIdSchema, parentRevision: revisionSchema }));
export const fieldTemplateOptionSchema = z.strictObject({ id: publicIdSchema, name: z.string(), revision: revisionSchema });

const cardField = target.extend({
  groupId: publicIdSchema, fieldId: publicIdSchema, groupRevision: revisionSchema, definitionRevision: revisionSchema,
});
export const fieldValueTextSchema = z.string().refine((value) => !/[\uD800-\uDFFF]/u.test(value) && Array.from(value).length <= 512,
  'Enter no more than 512 Unicode characters.');

function operation<const ID extends string, const Method extends 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  const Path extends string, const Status extends 200 | 201 | 204, Input extends z.ZodType, Output extends z.ZodType>(
  id: ID, method: Method, path: Path, status: Status, input: Input, output: Output,
) {
  return { id, kind: 'command', method, path, status, target: 'parent', input, output } as const;
}

export const fieldCommands = {
  'fields.createTemplate': operation('fields.createTemplate', 'POST', '/api/v1/projects/:id/field-templates', 201,
    target.extend({ name, ...groupPlacement }), groupResult),
  'fields.createGroup': {
    ...operation('fields.createGroup', 'POST', '/api/v1/boards/:id/field-groups', 201,
      target.extend({ scopeType: z.enum(['board', 'card']), name: name.nullable().default(null),
        templateGroupId: publicIdSchema.nullable().default(null), ...groupPlacement })
        .refine((value) => value.name !== null || value.templateGroupId !== null), groupResult),
    routes: [
      { path: '/api/v1/boards/:id/field-groups', fixed: { scopeType: 'board' } },
      { path: '/api/v1/cards/:id/field-groups', fixed: { scopeType: 'card' } },
    ],
  },
  'fields.updateGroup': operation('fields.updateGroup', 'PATCH', '/api/v1/field-groups/:id', 200,
    target.extend({ name: name.nullable().optional(), ...groupPlacement })
      .refine((value) => value.name !== undefined || value.beforeGroupId !== undefined), groupResult),
  'fields.deleteGroup': operation('fields.deleteGroup', 'DELETE', '/api/v1/field-groups/:id', 204, target.extend({ confirm: z.literal(true) }), fieldGroupDeleteReceipt),
  'fields.detachGroup': operation('fields.detachGroup', 'POST', '/api/v1/field-groups/:id/detach', 200, target, groupResult),
  'fields.promoteGroup': operation('fields.promoteGroup', 'POST', '/api/v1/field-groups/:id/promote', 201,
    target.extend({ projectRevision: revisionSchema, name: name.optional() }), groupResult),
  'fields.create': operation('fields.create', 'POST', '/api/v1/field-groups/:id/fields', 201,
    target.extend({ name, showOnFront: z.boolean().default(false), ...definitionPlacement }), definitionResult),
  'fields.update': operation('fields.update', 'PATCH', '/api/v1/fields/:id', 200,
    target.extend({ groupId: publicIdSchema, name: name.optional(), showOnFront: z.boolean().optional(), ...definitionPlacement })
      .refine((value) => value.name !== undefined || value.showOnFront !== undefined || value.beforeFieldId !== undefined), definitionResult),
  'fields.delete': operation('fields.delete', 'DELETE', '/api/v1/fields/:id', 204, target.extend({ groupId: publicIdSchema }), fieldDefinitionDeleteReceipt),
  'fields.setValue': operation('fields.setValue', 'PUT', '/api/v1/cards/:id/field-values/:groupId/:fieldId', 200,
    cardField.extend({ value: fieldValueTextSchema }), valueResult),
  'fields.clearValue': operation('fields.clearValue', 'DELETE', '/api/v1/cards/:id/field-values/:groupId/:fieldId', 204, cardField, valueResult),
} as const;
