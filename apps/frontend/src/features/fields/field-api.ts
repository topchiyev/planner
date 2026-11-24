import { fieldCommands, type RelationshipCommandOutput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import { workspaceResponse } from '../workspace/workspace-api.js';

export const fieldErrors = new Map([
  ['FIELD_ORDER_CONFLICT', 'The field order changed. Review it and try again.'],
  ['FIELD_GROUP_NAME_REQUIRED', 'Enter a name for this field group.'],
  ['FIELD_TEMPLATE_UNAVAILABLE', 'Choose an available field template from this project.'],
]);

export function useFieldMutation() {
  return useWorkspaceMutation(fieldErrors, 'The fields or your access changed. Review the current information and try again.');
}

export async function fieldCommand<K extends keyof typeof fieldCommands>(name: K, csrf: string, key: string, options: {
  id: string; revision: number; scope?: 'board' | 'card'; groupId?: string; fieldId?: string; body: object;
}) {
  const operation = fieldCommands[name];
  const template = 'routes' in operation ? operation.routes.find(({ fixed }) => fixed.scopeType === options.scope)?.path : operation.path;
  if (!template) throw new TypeError('Select a field group scope.');
  let path = template;
  for (const [part, id] of Object.entries({ id: options.id, groupId: options.groupId, fieldId: options.fieldId })) {
    if (id !== undefined) path = path.replace(':' + part, publicIdSchema.parse(id));
  }
  const reply = await workspaceResponse(path, { method: operation.method, headers: {
    'X-CSRF-Token': csrf, 'Idempotency-Key': key, 'If-Match': `"${options.revision}"`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(options.body) });
  return reply.status === 204 ? undefined : operation.output.parse(await reply.json()) as RelationshipCommandOutput<K>;
}
