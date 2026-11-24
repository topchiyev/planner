import { randomUUID } from 'node:crypto';
import type { RelationshipCommandInput } from '@planner/contracts';
import { decodeRank, encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
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

function copyDefinitions(group: FieldGroup, destinationId: string, definitions: FieldDefinition[], timestamp: string, retainLocal: boolean) {
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
    const fields = { fieldGroupId: destinationId, name: definition.name, showOnFront: definition.showOnFront === true,
      rank: rank.toString(), createdAt: timestamp, updatedAt: null };
    effects.push({ kind: 'insert', collection: 'fieldDefinitions', id, fields });
    return { ...fields, _id: group.generationId + '/' + id, generationId: group.generationId, id, revision: 1,
      rank: encodeRank(rank), createdAt: new Date(timestamp) };
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
  const template: FieldGroup = { ...fields, _id: generationId + '/' + id, generationId, id, revision: 1,
    rank: encodeRank(placement.rank), createdAt: new Date(timestamp) };
  const copy = copyDefinitions(group, id, effective.definitions, timestamp, false);
  const parent = changeFieldOwner(destination, timestamp, true);
  return {
    effects: [{ kind: 'insert', collection: 'fieldGroups', id, fields }, ...copy.effects, ...placement.effects, parent.effect],
    result: groupResult(template, null, copy.definitions, parent),
    audit: fieldAudit('fields.promoteGroup', id), events: fieldEvents(await affectedFieldBoards(records, generationId, destination)),
  };
}

/** For an already-authorized transfer, scope the source to one card's current board placement. Caller owns card changes and invalidations. */
export async function planTransferredCardFieldGroup(records: WorkspaceRecords, source: FieldGroup,
  { id: cardId, boardId, projectId, rank }: { id: string; boardId: string; projectId: string; rank: string }, timestamp: string) {
  if (source.scopeType !== 'board' || source.scopeId !== boardId
    || !(await ownedFieldCards(records, source, boardId, [cardId])).length) throw new RelationshipError('fieldTemplate');
  const effective = await effectiveGroup(records, source, projectId);
  const id = randomUUID();
  const copy = copyDefinitions(source, id, effective.definitions, timestamp, false);
  const values = await remapValues(records, source, id, copy.remap, timestamp, boardId, cardId);
  const effect: PlannedEffect = { kind: 'insert', collection: 'fieldGroups', id, fields: {
    name: effective.name, scopeType: 'card', scopeId: cardId, templateGroupId: null, rank, fieldOrderVersion: 1,
    createdAt: timestamp, updatedAt: null,
  } };
  return { groupId: id, effects: [effect, ...copy.effects, ...values.effects] };
}
