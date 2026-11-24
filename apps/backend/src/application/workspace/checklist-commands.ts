import { randomUUID } from 'node:crypto';
import { checklistDeleteReceipt, taskDeleteReceipt, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import {
  changedCard, checklistEvent, checklistOrderVersion, checklistRows, placeInOrder, taskRows,
} from './checklist-state.js';
import { readTerminalDeletionReceipt } from './deletion-receipt.js';
import { RelationshipError, requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import type { WorkspaceRecords } from './records.js';

export type ChecklistAccess = Awaited<ReturnType<WorkspaceAuthorization['requireChecklist']>>;
type ChildDeletion = 'checklists.delete' | 'tasks.delete';

export async function authorizeChecklistCreate(scope: WorkspaceAuthorization, id: string) {
  const card = await scope.requireCard(id);
  requireCapability(card.permissions.canEdit);
  return card;
}

export async function authorizeChecklistEdit(scope: WorkspaceAuthorization, id: string) {
  const result = await scope.requireChecklist(id);
  requireCapability(result.card.permissions.canEdit);
  return result;
}

export async function authorizeOwnedDeletion<Access>(database: Db, scope: WorkspaceAuthorization, operation: ChildDeletion,
  input: RelationshipCommandInput<ChildDeletion>, idempotencyKey: string | undefined, live: () => Promise<Access>,
) {
  try {
    return await live();
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !idempotencyKey) throw error;
    const receipt = await readTerminalDeletionReceipt(database, scope, operation, idempotencyKey, input);
    const parsed = (operation === 'checklists.delete' ? checklistDeleteReceipt : taskDeleteReceipt).safeParse(receipt);
    if (!parsed.success || parsed.data.data.id !== input.id) throw error;
    await authorizeChecklistCreate(scope, parsed.data.data.cardId);
  }
}

const checklistAudit = (action: string, id: string) => ({ action, resourceId: id, resourceType: 'checklist' });
const receipt = (id: string, revision: number, cardRevision: number, checklistOrderVersion: number) => ({
  data: { checklist: { id, revision }, cardRevision, checklistOrderVersion },
});

export async function planChecklistCreate(records: WorkspaceRecords, { card }: CardAccessContext,
  input: RelationshipCommandInput<'checklists.create'>, { generationId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  requireRevision(card, input.expectedRevision);
  const id = randomUUID();
  const placement = placeInOrder('checklists', await checklistRows(records, generationId, card.id), id, input.beforeChecklistId, timestamp);
  if (!placement.movingRank) throw new Error('A new checklist must be ranked.');
  const parent = changedCard(card, timestamp, true);
  return {
    effects: [{ kind: 'insert', collection: 'checklists', id, fields: {
      cardId: card.id, name: input.name, showOnFront: input.showOnFront, hideCompleted: input.hideCompleted,
      rank: placement.movingRank, orderVersion: 1, createdAt: timestamp, updatedAt: null,
    } }, ...placement.effects, parent.effect],
    result: receipt(id, 1, parent.revision, parent.orderVersion),
    audit: checklistAudit('checklists.create', id), events: checklistEvent(card, parent.revision),
  };
}

export async function planChecklistUpdate(records: WorkspaceRecords, { checklist, card: { card } }: ChecklistAccess,
  input: RelationshipCommandInput<'checklists.update'>, { generationId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  const revision = requireRevision(checklist, input.expectedRevision)!;
  const version = checklistOrderVersion(card);
  if (input.beforeChecklistId !== undefined && input.checklistOrderVersion !== version) throw new RelationshipError('checklistOrder');
  const placement = input.beforeChecklistId === undefined ? null : placeInOrder('checklists',
    await checklistRows(records, generationId, card.id), checklist.id, input.beforeChecklistId, timestamp);
  const fields: JournalFields = {
    ...(input.name !== undefined && input.name !== checklist.name && { name: input.name }),
    ...(input.showOnFront !== undefined && input.showOnFront !== (checklist.showOnFront ?? false) && { showOnFront: input.showOnFront }),
    ...(input.hideCompleted !== undefined && input.hideCompleted !== (checklist.hideCompleted ?? false) && { hideCompleted: input.hideCompleted }),
    ...(placement?.movingRank !== undefined && { rank: placement.movingRank }),
  };
  const id = checklist.id;
  const audit = checklistAudit('checklists.update', id);
  if (!Object.keys(fields).length && !placement?.reordered) return {
    effects: [], result: receipt(id, revision, card.revision, version), audit,
  };
  const update = touchRevision('checklists', checklist, timestamp, revision);
  const parent = changedCard(card, timestamp, placement?.reordered === true);
  return {
    effects: [{ ...update, fields: { ...update.fields, ...fields } }, ...(placement?.effects ?? []), parent.effect],
    result: receipt(id, update.revision + 1, parent.revision, parent.orderVersion),
    audit, events: checklistEvent(card, parent.revision),
  };
}

export async function planChecklistDelete(records: WorkspaceRecords, access: ChecklistAccess | undefined,
  input: RelationshipCommandInput<'checklists.delete'>, { generationId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  if (!access) throw new WorkspaceAccessError('missing');
  const { checklist, card: { card } } = access;
  const revision = requireRevision(checklist, input.expectedRevision);
  const tasks = await taskRows(records, generationId, checklist.id);
  const effects = tasks.map((row): PlannedEffect => ({ kind: 'delete', collection: 'tasks', id: row.id, revision: rowRevision(row) }));
  const parent = changedCard(card, timestamp, true);
  return {
    effects: [...effects, { kind: 'delete', collection: 'checklists', id: checklist.id, revision }, parent.effect],
    result: { data: { id: checklist.id, cardId: card.id, parentRevision: parent.revision, checklistOrderVersion: parent.orderVersion } },
    audit: checklistAudit('checklists.delete', checklist.id), events: checklistEvent(card, parent.revision),
  };
}
