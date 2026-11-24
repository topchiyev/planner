import { randomUUID } from 'node:crypto';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { planTransferredCardFieldGroup, planTransferOwnedFieldGroup } from './field-copies.js';
import { fieldDefinitionRows, fieldGroupRows, fieldValueRows, resolveFieldTemplate } from './field-state.js';
import { planRankChange, type RankedRow } from './ordered-ranks.js';
import { together, type WorkspaceRecords, type WorkspaceRow } from './records.js';
import { touchRevision } from './relationship-policy.js';
import type { CardTransferIdentity } from './transfer-labels.js';

type Board = WorkspaceRow<'boards'>;

export async function planTransferFields(records: WorkspaceRecords, source: Board, destination: Board,
  { sourceId, destinationId }: CardTransferIdentity, { generationId, timestamp }: CommandPlanningContext) {
  const duplicate = sourceId !== destinationId;
  const [local, shared] = await together([
    fieldGroupRows(records, generationId, 'card', sourceId),
    fieldGroupRows(records, generationId, 'board', source.id),
  ]);
  const values = await fieldValueRows(records, generationId, shared.map(({ id }) => id), [sourceId]);
  const order: RankedRow[] = [];
  const effects: PlannedEffect[] = [];
  let detachedGroups = 0;
  for (const [index, group] of local.entries()) {
    // Renumber cloned groups so a fresh public ID cannot change the order of tied ranks.
    const rank = duplicate ? BigInt(index + 1) * 1024n : group.rank == null ? null : decodeRank(group.rank);
    const template = await resolveFieldTemplate(records, group, source.projectId);
    if (duplicate && typeof group.name !== 'string' && !template) continue;
    const changes = await planTransferOwnedFieldGroup(records, group, {
      id: sourceId, destinationCardId: destinationId, boardId: source.id,
      projectId: source.projectId, destinationProjectId: destination.projectId, rank: rank?.toString() ?? '0',
    }, timestamp);
    if (group.templateGroupId != null && changes.some((change) => change.kind !== 'delete'
        && change.collection === 'fieldGroups' && change.fields.templateGroupId === null)) detachedGroups++;
    effects.push(...changes);
    order.push({ id: group.id, rank });
  }

  let newGroups = 0;
  const localRanks = new Map<string, bigint>();
  for (const group of shared) {
    const candidates = values.filter(({ fieldGroupId }) => fieldGroupId === group.id);
    if (!candidates.length) continue;
    const template = await resolveFieldTemplate(records, group, source.projectId);
    if (!template && typeof group.name !== 'string') continue;
    const defs = new Set((await fieldDefinitionRows(records, generationId, template ? [group.id, template.id] : [group.id])).map(({ id }) => id));
    const exact = candidates.filter(({ fieldDefinitionId, value }) => defs.has(fieldDefinitionId) && typeof value === 'string');
    if (!exact.length) continue;
    if (source.id === destination.id) {
      for (const value of exact) effects.push({ kind: 'insert', collection: 'fieldValues', id: randomUUID(), fields: {
        cardId: destinationId, fieldGroupId: group.id, fieldDefinitionId: value.fieldDefinitionId, value: value.value,
        createdAt: timestamp, updatedAt: null,
      } });
      continue;
    }
    // The rank planner uses the original group ID solely as a temporary append identity.
    const ranks = new Map(planRankChange(order, group.id, null).map(({ id, rank }) => [id, rank]));
    const rank = ranks.get(group.id)!;
    for (const row of order) {
      const updated = ranks.get(row.id);
      if (updated === undefined) continue;
      row.rank = updated;
      localRanks.set(row.id, updated);
    }
    const copy = await planTransferredCardFieldGroup(records, group, {
      id: sourceId, destinationCardId: destinationId, boardId: source.id,
      projectId: source.projectId, destinationProjectId: destination.projectId, rank: rank.toString(),
    }, timestamp);
    order.push({ id: copy.groupId, rank });
    effects.push(...copy.effects);
    newGroups++;
  }
  for (const [id, rank] of localRanks) {
    const existing = effects.find((effect) => effect.collection === 'fieldGroups' && effect.id === id);
    if (existing?.kind === 'update' || existing?.kind === 'insert') existing.fields.rank = rank.toString();
    else {
      const row = local.find((candidate) => candidate.id === id);
      if (row && !duplicate) {
        const touch = touchRevision('fieldGroups', row, timestamp);
        effects.push({ ...touch, fields: { ...touch.fields, rank: rank.toString() } });
      }
    }
  }
  return { effects, newGroups, materialized: newGroups + detachedGroups };
}
