import { randomUUID } from 'node:crypto';
import { type RelationshipCommandInput } from '@planner/contracts';
import { maximumSignedInt64 } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { hasTerminalDeletionReceipt } from './deletion-receipt.js';
import { requireCapability, WorkspaceAccessError, type WorkspaceAuthorization } from './authorization.js';
import { RelationshipError, requireRevision, rowRevision } from './relationship-policy.js';
import { canonicalRow, equal, type WorkspaceRecords } from './records.js';

export async function planProjectCreate(records: WorkspaceRecords, input: RelationshipCommandInput<'projects.create'>,
  { actorId: userId, generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const last = await records.first('projects', { rank: { $type: 'long' }, $expr: canonicalRow(generationId) }, { rank: -1 });
  const rank = (last?.rank == null ? 0n : decodeRank(last.rank)) + 1024n;
  if (rank > maximumSignedInt64) throw new RelationshipError('projectPlacement');
  const id = randomUUID();
  const managerId = randomUUID();
  return { effects: [
    { kind: 'insert', collection: 'projects', id, fields: { ...input, hidden: false, backgroundId: null, backgroundPreset: null,
      ownerProjectManagerId: input.type === 'private' ? managerId : null, rank: rank.toString(), createdAt: timestamp, updatedAt: null } },
    { kind: 'insert', collection: 'projectManagers', id: managerId, revision: 1, fields: { projectId: id, userId, createdAt: timestamp } },
  ], result: { data: { id } }, audit: { action: 'projects.create', resourceId: id, resourceType: 'project' } };
}

export async function authorizeProjectDelete(database: Db, scope: WorkspaceAuthorization, input: RelationshipCommandInput<'projects.delete'>,
  idempotencyKey?: string) {
  try {
    const access = await scope.requireProject(input.id);
    requireCapability(access.permissions.canDelete);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !idempotencyKey) throw error;
    if (!await hasTerminalDeletionReceipt(database, scope, 'projects.delete', idempotencyKey, input)) throw error;
  }
}

export async function planProjectDelete(records: WorkspaceRecords, scope: WorkspaceAuthorization,
  input: RelationshipCommandInput<'projects.delete'>): Promise<CommandPlan> {
  const { project, permissions } = await scope.requireProject(input.id);
  requireCapability(permissions.canDelete);
  const { id } = project;
  const revision = requireRevision(project, input.expectedRevision);
  if (input.name !== project.name) throw new RelationshipError('projectName');
  const match = (field: string, value: string) => ({ [field]: value, $expr: equal(field, value) });
  if (await records.first('boards', match('projectId', id))) throw new RelationshipError('projectNotEmpty');

  const effects: PlannedEffect[] = [];
  for (const collection of ['projectFavorites', 'projectManagers', 'projectBackgrounds'] as const) {
    for (const row of await records.find(collection, match('projectId', id), { id: 1 })) {
      effects.push({ kind: 'delete', collection, id: row.id, revision: rowRevision(row) });
    }
  }
  const groups = await records.find('fieldGroups', { scopeType: 'project', scopeId: id,
    $expr: { $and: [equal('scopeType', 'project'), equal('scopeId', id)] } }, { id: 1 });
  for (const group of groups) {
    for (const definition of await records.find('fieldDefinitions', match('fieldGroupId', group.id), { id: 1 })) {
      effects.push({ kind: 'delete', collection: 'fieldDefinitions', id: definition.id, revision: rowRevision(definition) });
    }
    effects.push({ kind: 'delete', collection: 'fieldGroups', id: group.id, revision: rowRevision(group) });
  }
  effects.push({ kind: 'delete', collection: 'projects', id, revision });
  return { effects, result: { data: { id } }, audit: { action: 'projects.delete', resourceId: id, resourceType: 'project' } };
}
