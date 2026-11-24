import { randomUUID } from 'node:crypto';
import type { RelationshipCommandInput } from '@planner/contracts';
import { encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import {
  affectedFieldBoards, changeFieldOwner, fieldAudit, fieldEvents, missingField, nextFieldOrder,
  placeField, validTemplateChoice, type FieldOwner, type GroupEdit,
} from './field-planning.js';
import {
  definitionDto, fieldDefinitionOrder, fieldDefinitionRows, fieldGroupOrder, fieldGroupRows, groupDto,
  resolveFieldTemplate, type FieldDefinition, type FieldGroup, type FieldScope,
} from './field-state.js';
import type { WorkspaceRecords } from './records.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';

type Context = CommandPlanningContext;
type CreateGroup = RelationshipCommandInput<'fields.createGroup' | 'fields.createTemplate'>;
type EditDefinition = GroupEdit & { definition: FieldDefinition };

export function groupResult(group: FieldGroup, template: FieldGroup | null, definitions: FieldDefinition[],
  parent: { revision: number; orderVersion: number }) {
  const dto = groupDto(group, template, definitions);
  if (!dto) throw new RelationshipError('fieldName');
  return { data: { group: dto, parentRevision: parent.revision, groupOrderVersion: parent.orderVersion } };
}

export async function planFieldGroupCreate(records: WorkspaceRecords, owner: FieldOwner, input: CreateGroup,
  { generationId, timestamp }: Context): Promise<CommandPlan> {
  const { id: scopeId, expectedRevision, name, beforeGroupId, orderVersion } = input;
  requireRevision(owner.row, expectedRevision);
  const scopeType: FieldScope = 'scopeType' in input ? input.scopeType : 'project';
  const templateId = 'templateGroupId' in input ? input.templateGroupId : null;
  const template = templateId ? await records.get('fieldGroups', templateId) : null;
  if (templateId && !validTemplateChoice(template, owner.projectId)) throw new RelationshipError('fieldTemplate');
  const id = randomUUID();
  const placement = placeField('fieldGroups', await fieldGroupRows(records, generationId, scopeType, scopeId), id,
    { before: beforeGroupId, version: orderVersion }, fieldGroupOrder(owner.row), timestamp, true);
  if (placement.rank === undefined) throw new Error('A new field group must be ranked.');
  const parent = changeFieldOwner(owner, timestamp, true);
  const fields = { scopeType, scopeId, name, templateGroupId: templateId, fieldOrderVersion: 1, rank: placement.rank,
    createdAt: timestamp, updatedAt: null };
  const group: FieldGroup = { ...fields, _id: generationId + '/' + id, generationId, id, revision: 1,
    createdAt: new Date(timestamp), rank: encodeRank(placement.rank) };
  return {
    effects: [{ kind: 'insert', collection: 'fieldGroups', id, fields }, ...placement.effects, parent.effect],
    result: groupResult(group, template, template ? await fieldDefinitionRows(records, generationId, [template.id]) : [], parent),
    audit: fieldAudit(scopeType === 'project' ? 'fields.createTemplate' : 'fields.createGroup', id),
    events: fieldEvents(await affectedFieldBoards(records, generationId, owner)),
  };
}

export async function planFieldGroupUpdate(records: WorkspaceRecords, { group, owner }: GroupEdit,
  input: RelationshipCommandInput<'fields.updateGroup'>, { generationId, timestamp }: Context): Promise<CommandPlan> {
  const revision = requireRevision(group, input.expectedRevision)!;
  const version = fieldGroupOrder(owner.row);
  const { beforeGroupId, orderVersion } = input;
  const placement = placeField('fieldGroups', beforeGroupId === undefined ? []
    : await fieldGroupRows(records, generationId, group.scopeType, group.scopeId), group.id,
  { before: beforeGroupId, version: orderVersion }, version, timestamp);
  const template = await resolveFieldTemplate(records, group, owner.projectId);
  const name = input.name === undefined ? group.name ?? null : input.name;
  if (name === null && !template) throw new RelationshipError('fieldName');
  const definitions = await fieldDefinitionRows(records, generationId, template ? [group.id, template.id] : [group.id]);
  const audit = fieldAudit('fields.updateGroup', group.id);
  if (name === (group.name ?? null) && !placement.reordered) {
    return { effects: [], result: groupResult(group, template, definitions, { revision: owner.row.revision, orderVersion: version }), audit };
  }
  const parent = changeFieldOwner(owner, timestamp, placement.reordered);
  const rank = placement.rank === undefined ? group.rank ?? null : encodeRank(placement.rank);
  const touch = touchRevision('fieldGroups', group, timestamp, revision);
  return {
    effects: [{ ...touch, fields: { ...touch.fields, name, ...(placement.rank !== undefined && { rank: placement.rank }) } },
      ...placement.effects, parent.effect],
    result: groupResult({ ...group, name, rank, updatedAt: new Date(timestamp), revision: revision + 1 }, template, definitions, parent),
    audit, events: fieldEvents(await affectedFieldBoards(records, generationId, owner)),
  };
}

export function changeDefinitionParent(group: FieldGroup, timestamp: string, order: boolean) {
  const touch = touchRevision('fieldGroups', group, timestamp);
  const old = fieldDefinitionOrder(group);
  const version = order ? nextFieldOrder(old) : old;
  return { effect: { ...touch, fields: { ...touch.fields, fieldOrderVersion: version } }, revision: touch.revision + 1, version };
}

const definitionResult = (definition: FieldDefinition, revision: number, version: number) =>
  ({ data: { definition: definitionDto(definition), groupRevision: revision, orderVersion: version } });

export async function planFieldDefinitionCreate(records: WorkspaceRecords, { group, owner }: GroupEdit,
  input: RelationshipCommandInput<'fields.create'>, { generationId, timestamp }: Context): Promise<CommandPlan> {
  requireRevision(group, input.expectedRevision);
  const id = randomUUID();
  const placement = placeField('fieldDefinitions', await fieldDefinitionRows(records, generationId, [group.id]), id,
    { before: input.beforeFieldId, version: input.orderVersion }, fieldDefinitionOrder(group), timestamp, true);
  if (placement.rank === undefined) throw new Error('A new field definition must be ranked.');
  const changedGroup = changeDefinitionParent(group, timestamp, true);
  const fields = { fieldGroupId: group.id, name: input.name, showOnFront: input.showOnFront, rank: placement.rank,
    createdAt: timestamp, updatedAt: null };
  const definition: FieldDefinition = { ...fields, _id: generationId + '/' + id, generationId, id, revision: 1,
    createdAt: new Date(timestamp), rank: encodeRank(placement.rank) };
  return {
    effects: [{ kind: 'insert', collection: 'fieldDefinitions', id, fields }, ...placement.effects, changedGroup.effect,
      changeFieldOwner(owner, timestamp).effect],
    result: definitionResult(definition, changedGroup.revision, changedGroup.version), audit: fieldAudit('fields.create', id, 'fieldDefinition'),
    events: fieldEvents(await affectedFieldBoards(records, generationId, owner)),
  };
}

export async function planFieldDefinitionUpdate(records: WorkspaceRecords, { definition, group, owner }: EditDefinition,
  input: RelationshipCommandInput<'fields.update'>, { generationId, timestamp }: Context): Promise<CommandPlan> {
  const revision = requireRevision(definition, input.expectedRevision)!;
  const version = fieldDefinitionOrder(group);
  const placement = placeField('fieldDefinitions', input.beforeFieldId === undefined ? []
    : await fieldDefinitionRows(records, generationId, [group.id]), definition.id,
  { before: input.beforeFieldId, version: input.orderVersion }, version, timestamp);
  const fields: JournalFields = {};
  if (input.name !== undefined && input.name !== definition.name) fields.name = input.name;
  if (input.showOnFront !== undefined && input.showOnFront !== (definition.showOnFront === true)) fields.showOnFront = input.showOnFront;
  if (placement.rank !== undefined) fields.rank = placement.rank;
  const audit = fieldAudit('fields.update', definition.id, 'fieldDefinition');
  if (!Object.keys(fields).length && !placement.reordered) {
    return { effects: [], result: definitionResult(definition, group.revision, version), audit };
  }
  const touch = touchRevision('fieldDefinitions', definition, timestamp, revision);
  const parent = changeDefinitionParent(group, timestamp, placement.reordered);
  const updated = { ...definition, revision: revision + 1, updatedAt: new Date(timestamp),
    name: input.name ?? definition.name, showOnFront: input.showOnFront ?? definition.showOnFront === true,
    rank: placement.rank === undefined ? definition.rank ?? null : encodeRank(placement.rank) };
  return {
    effects: [{ ...touch, fields: { ...touch.fields, ...fields } }, ...placement.effects, parent.effect, changeFieldOwner(owner, timestamp).effect],
    result: definitionResult(updated, parent.revision, parent.version), audit,
    events: fieldEvents(await affectedFieldBoards(records, generationId, owner)),
  };
}

export function requireLiveField<T>(edit: T | undefined): T { return edit ?? missingField(); }
