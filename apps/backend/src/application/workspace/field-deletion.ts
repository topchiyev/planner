import { fieldDefinitionDeleteReceipt, fieldGroupDeleteReceipt, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { WorkspaceAccessError, type WorkspaceAuthorization } from './authorization.js';
import { readTerminalDeletionReceipt } from './deletion-receipt.js';
import {
  affectedFieldBoards, authorizeDefinitionEdit, authorizeFieldOwner, authorizeGroupEdit, changeFieldOwner,
  fieldAudit, fieldEvents, ownedFieldCards, templateInstances, type GroupEdit,
} from './field-planning.js';
import { fieldDefinitionRows, fieldValueRows, resolveFieldTemplate, type FieldDefinition, type FieldGroup } from './field-state.js';
import { changeDefinitionParent, requireLiveField } from './field-structures.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';
import { requireRevision, rowRevision, touchRevision } from './relationship-policy.js';

type GroupDelete = RelationshipCommandInput<'fields.deleteGroup'>;
type DefinitionDelete = RelationshipCommandInput<'fields.delete'>;
type DefinitionEdit = GroupEdit & { definition: FieldDefinition };

export async function authorizeFieldGroupDelete(database: Db, scope: WorkspaceAuthorization, input: GroupDelete, key?: string) {
  try {
    return await authorizeGroupEdit(scope, input.id);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !key) throw error;
    const receipt = fieldGroupDeleteReceipt.safeParse(await readTerminalDeletionReceipt(database, scope, 'fields.deleteGroup', key, input));
    if (!receipt.success || receipt.data.data.id !== input.id) throw error;
    await authorizeFieldOwner(scope, receipt.data.data.scopeType, receipt.data.data.scopeId);
  }
}

export async function authorizeFieldDefinitionDelete(database: Db, scope: WorkspaceAuthorization, input: DefinitionDelete, key?: string) {
  try {
    return await authorizeDefinitionEdit(scope, input.id, input.groupId);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !key) throw error;
    const receipt = fieldDefinitionDeleteReceipt.safeParse(await readTerminalDeletionReceipt(database, scope, 'fields.delete', key, input));
    if (!receipt.success || receipt.data.data.id !== input.id || receipt.data.data.groupId !== input.groupId) throw error;
    await authorizeGroupEdit(scope, input.groupId);
  }
}

function deleteRow(collection: 'fieldGroups' | 'fieldDefinitions' | 'fieldValues', row: FieldGroup | FieldDefinition | WorkspaceRow<'fieldValues'>): PlannedEffect {
  return { kind: 'delete', collection, id: row.id, revision: rowRevision(row) };
}

async function dependentValues(records: WorkspaceRecords, { group, owner }: GroupEdit, definitionIds: Iterable<string>) {
  const definitionSet = new Set(definitionIds);
  const rows = (await fieldValueRows(records, group.generationId, [group.id])).filter((row) => definitionSet.has(row.fieldDefinitionId));
  const cards = await ownedFieldCards(records, group, owner.boardId, [...new Set(rows.map(({ cardId }) => cardId))]);
  const valid = new Set(cards.map(({ id }) => id));
  return { cards, effects: rows.filter(({ cardId }) => valid.has(cardId)).map((row) => deleteRow('fieldValues', row)) };
}

export async function planFieldGroupDelete(records: WorkspaceRecords, edit: GroupEdit | undefined, input: GroupDelete,
  { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const original = requireLiveField(edit);
  const { group, owner } = original;
  requireRevision(group, input.expectedRevision);
  const instances = group.scopeType === 'project' ? await templateInstances(records, generationId, group) : [];
  const template = await resolveFieldTemplate(records, group, owner.projectId);
  const baseId = group.scopeType === 'project' ? group.id : template?.id;
  const base = baseId ? (await fieldDefinitionRows(records, generationId, [baseId])).map(({ id }) => id) : [];
  const parents = new Map<string, ReturnType<typeof changeFieldOwner>>();
  const affected = new Map<string, WorkspaceRow<'cards'>>();
  const boardIds = new Set<string>();
  const effects: PlannedEffect[] = [];
  let removedValues = 0;
  for (const scope of [original, ...instances]) {
    const member = scope.group;
    const definitions = await fieldDefinitionRows(records, generationId, [member.id]);
    const values = await dependentValues(records, scope, [...base, ...definitions.map(({ id }) => id)]);
    removedValues += values.effects.length;
    effects.push(...values.effects, ...definitions.map((row) => deleteRow('fieldDefinitions', row)), deleteRow('fieldGroups', member));
    if (scope.owner.boardId) boardIds.add(scope.owner.boardId);
    for (const card of values.cards) affected.set(card.id, card);
    parents.set(scope.owner.row.id, changeFieldOwner(scope.owner, timestamp, true));
  }
  const parent = parents.get(owner.row.id)!;
  return {
    effects: [...effects, ...[...parents.values()].map(({ effect }) => effect),
      ...[...affected.values()].filter(({ id }) => !parents.has(id)).map((card) => touchRevision('cards', card, timestamp))],
    result: { data: { id: group.id, scopeType: group.scopeType, scopeId: group.scopeId, parentRevision: parent.revision,
      removedGroups: instances.length + 1, removedValues } },
    audit: { ...fieldAudit('fields.deleteGroup', group.id), detail: { removedGroups: instances.length + 1, removedValues } },
    events: fieldEvents(boardIds),
  };
}

export async function planFieldDefinitionDelete(records: WorkspaceRecords, edit: DefinitionEdit | undefined,
  input: DefinitionDelete, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const original = requireLiveField(edit);
  const { group, owner, definition } = original;
  requireRevision(definition, input.expectedRevision);
  const instances = group.scopeType === 'project' ? await templateInstances(records, generationId, group) : [];
  const effects: PlannedEffect[] = [];
  const affected = new Map<string, WorkspaceRow<'cards'>>();
  for (const scope of [original, ...instances]) {
    const values = await dependentValues(records, scope, [definition.id]);
    effects.push(...values.effects);
    for (const card of values.cards) affected.set(card.id, card);
  }
  const parent = changeDefinitionParent(group, timestamp, true);
  const deleteOwner = changeFieldOwner(owner, timestamp);
  return {
    effects: [...effects, deleteRow('fieldDefinitions', definition), parent.effect, deleteOwner.effect,
      ...[...affected.values()].filter(({ id }) => owner.collection !== 'cards' || id !== owner.row.id).map((card) => touchRevision('cards', card, timestamp))],
    result: { data: { id: definition.id, groupId: group.id, parentRevision: parent.revision } },
    audit: fieldAudit('fields.delete', definition.id, 'fieldDefinition'),
    events: fieldEvents(await affectedFieldBoards(records, generationId, owner)),
  };
}
