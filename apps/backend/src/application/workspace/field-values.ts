import { randomUUID } from 'node:crypto';
import type { RelationshipCommandInput } from '@planner/contracts';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, type WorkspaceAuthorization } from './authorization.js';
import { fieldAudit } from './field-planning.js';
import { fieldValueRows } from './field-state.js';
import type { WorkspaceRecords } from './records.js';
import { requireRevision, rowRevision, touchRevision } from './relationship-policy.js';

type ValueInput = RelationshipCommandInput<'fields.clearValue' | 'fields.setValue'>;
type ValueAccess = Awaited<ReturnType<WorkspaceAuthorization['requireCardField']>>;

export async function authorizeFieldValue(access: WorkspaceAuthorization, input: ValueInput) {
  const value = await access.requireCardField(input.id, input.groupId, input.fieldId);
  requireCapability(value.card.permissions.canEdit);
  return value;
}

export async function planFieldValue(records: WorkspaceRecords, { card: { card }, group, definition }: ValueAccess,
  input: ValueInput, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const revision = requireRevision(card, input.expectedRevision)!;
  requireRevision(group, input.groupRevision);
  requireRevision(definition, input.definitionRevision);
  const row = (await fieldValueRows(records, generationId, [group.id], [card.id]))
    .find(({ fieldDefinitionId }) => fieldDefinitionId === definition.id);
  const audit = fieldAudit('value' in input ? 'fields.setValue' : 'fields.clearValue', card.id, 'card');
  let effect: PlannedEffect;
  if ('value' in input && row?.value !== input.value) {
    effect = row ? { kind: 'update', collection: 'fieldValues', id: row.id, revision: rowRevision(row),
      fields: { value: input.value, updatedAt: timestamp } }
      : { kind: 'insert', collection: 'fieldValues', id: randomUUID(), fields: {
        cardId: card.id, fieldGroupId: group.id, fieldDefinitionId: definition.id, value: input.value,
        createdAt: timestamp, updatedAt: null,
      } };
  } else if (!('value' in input) && row) {
    effect = { kind: 'delete', collection: 'fieldValues', id: row.id, revision: rowRevision(row) };
  } else {
    return { effects: [], result: { data: { cardId: card.id, revision } }, audit };
  }
  return {
    effects: [effect, touchRevision('cards', card, timestamp, revision)],
    result: { data: { cardId: card.id, revision: revision + 1 } }, audit,
    events: [{ boardId: card.boardId, kind: 'card.changed', payload: { id: card.id, revision: revision + 1 } }],
  };
}
