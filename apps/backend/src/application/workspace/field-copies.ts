import { randomUUID } from 'node:crypto';
import type { RelationshipCommandInput } from '@planner/contracts';
import { decodeRank, encodeRank, workspaceKey } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import type { WorkspaceAuthorization } from './authorization.js';
import {
  affectedFieldBoards, authorizeFieldOwner, authorizeGroupEdit, changeFieldOwner, fieldAudit, fieldEvents,
  nextFieldOrder, ownedFieldCards, placeField, type FieldOwner, type GroupEdit,
} from './field-planning.js';
import {
  fieldDefinitionOrder, fieldDefinitionRows, fieldGroupOrder, fieldGroupRows, fieldValueRows,
  resolveFieldTemplate, type FieldDefinition, type FieldGroup,
} from './field-state.js';
import { groupResult } from './field-structures.js';
import { RelationshipError, requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import type { WorkspaceRecords } from './records.js';

type Context = CommandPlanningContext;

async function effectiveGroup(records: WorkspaceRecords, group: FieldGroup, projectId: string) {
  const template = await resolveFieldTemplate(records, group, projectId);
  const name = group.name ?? template?.name;
  if (typeof name !== 'string') throw new RelationshipError('fieldName');
  const definitions = await fieldDefinitionRows(records, group.generationId, template ? [group.id, template.id] : [group.id]);
  return { name, template, definitions };
}

function copyDefinitions(group: FieldGroup, destinationId: string, definitions: FieldDefinition[], timestamp: string, retainLocal: boolean, preserveRanks = false) {
  const remap = new Map<string, string>();
  const effects: PlannedEffect[] = [];
  const rows = definitions.map((definition, index) => {
    const rank = BigInt(index + 1) * 1024n;
    if (retainLocal && definition.fieldGroupId === group.id) {
      if (definition.rank != null && decodeRank(definition.rank) === rank) return definition;
      const touch = touchRevision('fieldDefinitions', definition, timestamp);
      effects.push({ ...touch, fields: { ...touch.fields, rank: rank.toString() } });
      return { ...definition, rank: encodeRank(rank), revision: touch.revision + 1, updatedAt: new Date(timestamp) };
    }
    const id = randomUUID();
    remap.set(definition.id, id);
    const storedRank = preserveRanks ? definition.rank ?? null : encodeRank(rank);
    const fields = { fieldGroupId: destinationId, name: definition.name, showOnFront: definition.showOnFront === true,
      rank: storedRank == null ? null : decodeRank(storedRank).toString(), createdAt: timestamp, updatedAt: null };
    effects.push({ kind: 'insert', collection: 'fieldDefinitions', id, fields });
    return { ...fields, _id: workspaceKey(group.generationId, id), generationId: group.generationId, id, revision: 1,
      rank: storedRank, createdAt: new Date(timestamp) };
  });
  return { definitions: rows, remap, effects };
}

async function remapValues(records: WorkspaceRecords, source: FieldGroup, destinationId: string, remap: Map<string, string>,
  timestamp: string, boardId: string | null, onlyCard?: string) {
  const rows = (await fieldValueRows(records, source.generationId, [source.id], onlyCard ? [onlyCard] : undefined))
    .filter(({ fieldDefinitionId }) => remap.has(fieldDefinitionId));
  const cards = await ownedFieldCards(records, source, boardId, [...new Set(rows.map(({ cardId }) => cardId))]);
  const valid = new Set(cards.map(({ id }) => id));
  const effects = rows.flatMap((row): PlannedEffect[] => valid.has(row.cardId) ? [{
    kind: 'update', collection: 'fieldValues', id: row.id, revision: rowRevision(row),
    fields: { fieldGroupId: destinationId, fieldDefinitionId: remap.get(row.fieldDefinitionId)!, updatedAt: timestamp },
  }] : []);
  return { effects, cards };
}

export async function planFieldDetach(records: WorkspaceRecords, { group, owner }: GroupEdit,
  input: RelationshipCommandInput<'fields.detachGroup'>, { timestamp }: Context): Promise<CommandPlan> {
  const revision = requireRevision(group, input.expectedRevision)!;
  const effective = await effectiveGroup(records, group, owner.projectId);
  if (!effective.template) throw new RelationshipError('fieldDetach');
  const copy = copyDefinitions(group, group.id, effective.definitions, timestamp, true);
  const values = await remapValues(records, group, group.id, copy.remap, timestamp, owner.boardId);
  const version = nextFieldOrder(fieldDefinitionOrder(group));
  const parent = changeFieldOwner(owner, timestamp);
  const touch = touchRevision('fieldGroups', group, timestamp, revision);
  const changes = { name: effective.name, templateGroupId: null, fieldOrderVersion: version };
  return {
    effects: [...copy.effects, ...values.effects, { ...touch, fields: { ...touch.fields, ...changes } }, parent.effect,
      ...values.cards.filter(({ id }) => owner.collection !== 'cards' || id !== owner.row.id).map((card) => touchRevision('cards', card, timestamp))],
    result: groupResult({ ...group, ...changes, revision: revision + 1, updatedAt: new Date(timestamp) }, null, copy.definitions, parent),
    audit: fieldAudit('fields.detachGroup', group.id), events: fieldEvents(owner.boardId ? [owner.boardId] : []),
  };
}

export async function authorizeFieldPromotion(access: WorkspaceAuthorization, id: string) {
  const source = await authorizeGroupEdit(access, id);
  if (source.group.scopeType === 'project') throw new RelationshipError('fieldTemplate');
  return { source, destination: await authorizeFieldOwner(access, 'project', source.owner.projectId) };
}

export async function planFieldPromotion(records: WorkspaceRecords, { source, destination }: { source: GroupEdit; destination: FieldOwner },
  input: RelationshipCommandInput<'fields.promoteGroup'>, { generationId, timestamp }: Context): Promise<CommandPlan> {
  const { group } = source;
  requireRevision(group, input.expectedRevision);
  requireRevision(destination.row, input.projectRevision);
  const effective = await effectiveGroup(records, group, destination.projectId);
  const id = randomUUID();
  const placement = placeField('fieldGroups', await fieldGroupRows(records, generationId, 'project', destination.projectId), id,
    {}, fieldGroupOrder(destination.row), timestamp, true);
  if (placement.rank === undefined) throw new Error('A new template must be ranked.');
  const fields = { name: input.name ?? effective.name, scopeType: 'project' as const, scopeId: destination.projectId,
    templateGroupId: null, fieldOrderVersion: 1, rank: placement.rank, createdAt: timestamp, updatedAt: null };
  const template: FieldGroup = { ...fields, _id: workspaceKey(generationId, id), generationId, id, revision: 1,
    rank: encodeRank(placement.rank), createdAt: new Date(timestamp) };
  const copy = copyDefinitions(group, id, effective.definitions, timestamp, false);
  const parent = changeFieldOwner(destination, timestamp, true);
  return {
    effects: [{ kind: 'insert', collection: 'fieldGroups', id, fields }, ...copy.effects, ...placement.effects, parent.effect],
    result: groupResult(template, null, copy.definitions, parent),
    audit: fieldAudit('fields.promoteGroup', id), events: fieldEvents(await affectedFieldBoards(records, generationId, destination)),
  };
}

type TransferFieldTarget = { id: string; boardId: string; projectId: string; rank: string;
  destinationCardId?: string; destinationProjectId?: string };

async function transferFieldCopy(records: WorkspaceRecords, source: FieldGroup,
  { id: cardId, projectId, rank, destinationCardId = cardId, destinationProjectId }: TransferFieldTarget,
  timestamp: string) {
  const effective = await effectiveGroup(records, source, projectId);
  const local = effective.definitions.filter(({ fieldGroupId }) => fieldGroupId === source.id);
  const positionKey = ({ rank }: FieldDefinition) => rank == null ? null : decodeRank(rank).toString();
  const counts = new Map<string | null, number>();
  for (const definition of effective.definitions) {
    const key = positionKey(definition);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // With tied local ranks a fresh ID could change the inherited display order, so materialize the full order.
  const template = destinationProjectId === projectId && local.every((definition) => counts.get(positionKey(definition)) === 1)
    ? effective.template : null;
  const id = randomUUID();
  const copy = copyDefinitions(source, id, template ? local : effective.definitions, timestamp, false, !!template);
  if (template) for (const definition of effective.definitions) {
    if (definition.fieldGroupId === template.id) copy.remap.set(definition.id, definition.id);
  }
  const rows = await fieldValueRows(records, source.generationId, [source.id], [cardId]);
  const values = rows.flatMap((value): PlannedEffect[] => {
    const fieldDefinitionId = copy.remap.get(value.fieldDefinitionId);
    if (!fieldDefinitionId || typeof value.value !== 'string') return [];
    return destinationCardId === cardId
      ? [{ kind: 'update', collection: 'fieldValues', id: value.id, revision: rowRevision(value),
        fields: { fieldGroupId: id, fieldDefinitionId, updatedAt: timestamp } }]
      : [{ kind: 'insert', collection: 'fieldValues', id: randomUUID(), fields: {
        cardId: destinationCardId, fieldGroupId: id, fieldDefinitionId, value: value.value, createdAt: timestamp, updatedAt: null,
      } }];
  });
  const effect: PlannedEffect = { kind: 'insert', collection: 'fieldGroups', id, fields: {
    name: template ? source.name ?? null : effective.name, scopeType: 'card', scopeId: destinationCardId,
    templateGroupId: template?.id ?? null, rank, fieldOrderVersion: 1, createdAt: timestamp, updatedAt: null,
  } };
  return { groupId: id, effects: [effect, ...copy.effects, ...values] };
}

/** For an already-authorized transfer, scope a board instance to the one card being transferred. */
export async function planTransferredCardFieldGroup(records: WorkspaceRecords, source: FieldGroup, target: TransferFieldTarget, timestamp: string) {
  const board = await records.get('boards', target.boardId);
  if (source.scopeType !== 'board' || source.scopeId !== target.boardId || board?.projectId !== target.projectId
    || !(await ownedFieldCards(records, source, target.boardId, [target.id])).length) throw new RelationshipError('fieldTemplate');
  return transferFieldCopy(records, source, target, timestamp);
}

/** Move a card-owned instance in place, or give its duplicate independent local definitions and values. */
export async function planTransferOwnedFieldGroup(records: WorkspaceRecords, source: FieldGroup, target: TransferFieldTarget, timestamp: string) {
  if (source.scopeType !== 'card' || source.scopeId !== target.id) throw new RelationshipError('fieldTemplate');
  if (target.destinationCardId && target.destinationCardId !== target.id) return (await transferFieldCopy(records, source, target, timestamp)).effects;
  const template = await resolveFieldTemplate(records, source, target.projectId);
  const keepTemplate = template && target.destinationProjectId === target.projectId;
  if (keepTemplate || source.templateGroupId == null) return [];
  let fields: JournalFields = { templateGroupId: null };
  let effects: PlannedEffect[] = [];
  if (template) {
    const effective = await effectiveGroup(records, source, target.projectId);
    const copy = copyDefinitions(source, source.id, effective.definitions, timestamp, true);
    const remapped = await remapValues(records, source, source.id, copy.remap, timestamp, target.boardId, target.id);
    fields = { ...fields, name: effective.name, fieldOrderVersion: nextFieldOrder(fieldDefinitionOrder(source)) };
    effects = [...copy.effects, ...remapped.effects];
  }
  const change = touchRevision('fieldGroups', source, timestamp);
  return [...effects, { ...change, fields: { ...change.fields, ...fields } }];
}
