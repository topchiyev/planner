import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import { canonicalRow, equal, publicIdField, rankSort, type WorkspaceRecords, type WorkspaceRow } from './records.js';

export type FieldGroup = WorkspaceRow<'fieldGroups'>;
export type FieldDefinition = WorkspaceRow<'fieldDefinitions'>;
export type FieldScope = FieldGroup['scopeType'];
export type FieldOwnerRow = WorkspaceRow<'projects'> | WorkspaceRow<'boards'> | WorkspaceRow<'cards'>;

export const fieldGroupOrder = (owner: Pick<FieldOwnerRow, 'fieldGroupOrderVersion'>) => revisionSchema.parse(owner.fieldGroupOrderVersion ?? 1);
export const fieldDefinitionOrder = (group: Pick<FieldGroup, 'fieldOrderVersion'>) => revisionSchema.parse(group.fieldOrderVersion ?? 1);
const time = (row: FieldGroup | FieldDefinition) => ({
  id: row.id, revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null,
  rank: row.rank == null ? null : decodeRank(row.rank).toString(),
});

export async function resolveFieldTemplate(records: WorkspaceRecords, group: Pick<FieldGroup, 'templateGroupId' | 'scopeType'>,
  projectId: string): Promise<FieldGroup | null> {
  const id = publicIdSchema.safeParse(group.templateGroupId);
  if (!id.success || group.scopeType === 'project') return null;
  const template = await records.get('fieldGroups', id.data);
  return template?.scopeType === 'project' && template.scopeId === projectId && template.templateGroupId == null
    && typeof template.name === 'string' ? template : null;
}

export function fieldGroupRows(records: WorkspaceRecords, generationId: string, scopeType: FieldScope, scopeId: string) {
  return records.find('fieldGroups', { scopeType, scopeId,
    $expr: { $and: [canonicalRow(generationId), equal('scopeType', scopeType), equal('scopeId', scopeId)] } }, rankSort);
}

export function fieldDefinitionRows(records: WorkspaceRecords, generationId: string, ids: string[]) {
  return records.find('fieldDefinitions', { fieldGroupId: { $in: ids },
    $expr: { $and: [canonicalRow(generationId), { $in: ['$fieldGroupId', ids] }] } }, rankSort);
}

export function fieldValueRows(records: WorkspaceRecords, generationId: string, groups: string[], cards?: string[]) {
  const match = (field: string, values: string[]) => ({ $in: ['$' + field, values] });
  return records.find('fieldValues', {
    fieldGroupId: { $in: groups }, ...(cards && { cardId: { $in: cards } }),
    $expr: { $and: [canonicalRow(generationId), match('fieldGroupId', groups), publicIdField('cardId'), publicIdField('fieldDefinitionId'),
      ...(cards ? [match('cardId', cards)] : [])] },
  }, { cardId: 1, fieldGroupId: 1, fieldDefinitionId: 1, id: 1 });
}

export function definitionDto(definition: FieldDefinition, instanceId = definition.fieldGroupId) {
  return { ...time(definition), name: definition.name, fieldGroupId: instanceId, showOnFront: definition.showOnFront === true,
    inherited: definition.fieldGroupId !== instanceId };
}

export function groupDto(group: FieldGroup, template: FieldGroup | null, definitions: FieldDefinition[]) {
  const name = group.name ?? template?.name;
  if (typeof name !== 'string') return null;
  return { ...time(group), name, localName: group.name ?? null, linked: !!template, orderVersion: fieldDefinitionOrder(group),
    scopeType: group.scopeType, scopeId: group.scopeId, definitions: definitions.map((definition) => definitionDto(definition, group.id)) };
}

export async function projectFieldGroup(records: WorkspaceRecords, generationId: string, group: FieldGroup, projectId: string) {
  const template = await resolveFieldTemplate(records, group, projectId);
  const defs = await fieldDefinitionRows(records, generationId, template ? [group.id, template.id] : [group.id]);
  return groupDto(group, template, defs);
}
