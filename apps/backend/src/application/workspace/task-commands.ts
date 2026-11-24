import { randomUUID } from 'node:crypto';
import type { RelationshipCommandInput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { authorizeChecklistEdit, type ChecklistAccess } from './checklist-commands.js';
import { cardClosed } from './card-state.js';
import {
  changedCard, changedChecklist, checklistEvent, checklistPosition, placeInOrder, taskOrderVersion, taskRows,
} from './checklist-state.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import type { WorkspaceRecords } from './records.js';

type TaskAccess = Awaited<ReturnType<WorkspaceAuthorization['requireTask']>>;
const taskAudit = (action: string, id: string) => ({ action, resourceId: id, resourceType: 'task' });
const receipt = (id: string, revision: number, checklist: ReturnType<typeof checklistPosition>, cardRevision: number) => ({
  data: { task: { id, revision }, checklist, cardRevision },
});

export async function authorizeTaskEdit(scope: WorkspaceAuthorization, id: string) {
  const result = await scope.requireTask(id);
  requireCapability(result.card.permissions.canEdit);
  return result;
}

export async function authorizeTaskCreate(scope: WorkspaceAuthorization, input: RelationshipCommandInput<'tasks.create'>) {
  const access = await authorizeChecklistEdit(scope, input.id);
  const target = 'linkedCardId' in input ? await scope.requireCard(input.linkedCardId) : null;
  return { ...access, target };
}

export async function authorizeTaskMove(scope: WorkspaceAuthorization, input: RelationshipCommandInput<'tasks.move'>) {
  const access = await authorizeTaskEdit(scope, input.id);
  const id = access.card.card.id;
  const destination = input.toChecklistId === access.checklist.id ? access.checklist : (await scope.requireChecklist(input.toChecklistId, id)).checklist;
  if (access.task.linkedUnavailable) throw new WorkspaceAccessError('missing');
  if (access.task.linkedCardId != null) {
    const link = publicIdSchema.safeParse(access.task.linkedCardId);
    if (!link.success) throw new WorkspaceAccessError('missing');
    await scope.requireCard(link.data);
  }
  return { ...access, destination };
}

async function validateAssignee(records: WorkspaceRecords, generationId: string, boardId: string, assigneeId: string | null) {
  if (assigneeId === null) return;
  const [member] = await eligibleBoardPeople(records, generationId, boardId, { id: assigneeId });
  if (!member) throw new RelationshipError('target');
}

export async function planTaskCreate(records: WorkspaceRecords, { checklist, card: { card }, target }: ChecklistAccess & { target: CardAccessContext | null },
  input: RelationshipCommandInput<'tasks.create'>, { generationId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  requireRevision(checklist, input.expectedRevision);
  const id = randomUUID();
  const placement = placeInOrder('tasks', await taskRows(records, generationId, checklist.id), id, input.beforeTaskId, timestamp);
  if (!placement.movingRank) throw new Error('A new task must be ranked.');
  let fields: JournalFields;
  if ('linkedCardId' in input) {
    if (!target || target.card.id !== input.linkedCardId) throw new WorkspaceAccessError('missing');
    fields = { linkedCardId: input.linkedCardId, completed: cardClosed(target.card, target.list), name: null, assigneeId: null };
  } else {
    await validateAssignee(records, generationId, card.boardId, input.assigneeId);
    fields = { name: input.name, completed: false, assigneeId: input.assigneeId, linkedCardId: null };
  }
  const parent = changedChecklist(checklist, timestamp, true);
  const owner = changedCard(card, timestamp, false);
  return {
    effects: [{ kind: 'insert', collection: 'tasks', id, fields: {
      ...fields, checklistId: checklist.id, rank: placement.movingRank, createdAt: timestamp, updatedAt: null,
    } }, ...placement.effects, parent.effect, owner.effect],
    result: receipt(id, 1, parent.position, owner.revision),
    audit: taskAudit('tasks.create', id), events: checklistEvent(card, owner.revision),
  };
}

export async function planTaskUpdate(records: WorkspaceRecords, { task, checklist, card: { card } }: TaskAccess,
  input: RelationshipCommandInput<'tasks.update'>, { generationId, timestamp, actorId, commandId }: CommandPlanningContext,
): Promise<CommandPlan> {
  const revision = requireRevision(task, input.expectedRevision)!;
  if (task.linkedUnavailable || task.linkedCardId != null) throw new RelationshipError('taskFields');
  if (input.assigneeId !== undefined) await validateAssignee(records, generationId, card.boardId, input.assigneeId);
  const completed = input.completed !== undefined && input.completed !== (task.completed ?? false);
  const fields: JournalFields = {
    ...(input.name !== undefined && input.name !== task.name && { name: input.name }),
    ...(input.assigneeId !== undefined && input.assigneeId !== (task.assigneeId ?? null) && { assigneeId: input.assigneeId }),
    ...(completed && { completed: input.completed! }),
  };
  const id = task.id;
  const audit = taskAudit('tasks.update', id);
  if (!Object.keys(fields).length) return {
    effects: [], result: receipt(id, revision, checklistPosition(checklist), card.revision), audit,
  };
  const update = touchRevision('tasks', task, timestamp, revision);
  const parent = changedChecklist(checklist, timestamp, false);
  const owner = changedCard(card, timestamp, false);
  const effects: PlannedEffect[] = [{ ...update, fields: { ...update.fields, ...fields } }, parent.effect, owner.effect];
  if (completed) effects.push({ kind: 'insert', collection: 'activities', id: randomUUID(), fields: {
    cardId: card.id, boardId: card.boardId, taskId: id, actorId, commandId,
    kind: input.completed ? 'completeTask' : 'uncompleteTask', createdAt: timestamp,
  } });
  return { effects, result: receipt(id, update.revision + 1, parent.position, owner.revision),
    audit, events: checklistEvent(card, owner.revision) };
}

export async function planTaskMove(records: WorkspaceRecords, { task, checklist, card: { card }, destination }: TaskAccess & { destination: TaskAccess['checklist'] },
  input: RelationshipCommandInput<'tasks.move'>, { generationId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  const revision = requireRevision(task, input.expectedRevision)!;
  if (input.sourceOrderVersion !== taskOrderVersion(checklist) || input.destinationOrderVersion !== taskOrderVersion(destination)) {
    throw new RelationshipError('checklistOrder');
  }
  const placement = placeInOrder('tasks', await taskRows(records, generationId, destination.id), task.id, input.beforeTaskId, timestamp);
  const same = checklist.id === destination.id;
  const audit = taskAudit('tasks.move', task.id);
  const result = (taskRevision: number, source: ReturnType<typeof checklistPosition>, destination: ReturnType<typeof checklistPosition>, cardRevision: number) =>
    ({ data: { task: { id: task.id, revision: taskRevision }, source, destination, cardRevision } });
  if (same && !placement.reordered) return {
    effects: [], result: result(revision, checklistPosition(checklist), checklistPosition(destination), card.revision), audit,
  };
  if (!same && !placement.movingRank) throw new Error('A moved task must have a destination rank.');
  const current = touchRevision('tasks', task, timestamp, revision);
  const source = changedChecklist(checklist, timestamp, true);
  const next = same ? source : changedChecklist(destination, timestamp, true);
  const owner = changedCard(card, timestamp, false);
  return {
    effects: [{ ...current, fields: { ...current.fields, ...(!same && { checklistId: destination.id }),
      ...(placement.movingRank !== undefined && { rank: placement.movingRank }) } }, ...placement.effects,
    source.effect, ...(same ? [] : [next.effect]), owner.effect],
    result: result(revision + 1, source.position, next.position, owner.revision), audit, events: checklistEvent(card, owner.revision),
  };
}

export async function planTaskDelete(_records: WorkspaceRecords, access: TaskAccess | undefined,
  input: RelationshipCommandInput<'tasks.delete'>, { timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  if (!access) throw new WorkspaceAccessError('missing');
  const { task, checklist, card: { card } } = access;
  const revision = requireRevision(task, input.expectedRevision);
  const parent = changedChecklist(checklist, timestamp, true);
  const owner = changedCard(card, timestamp, false);
  return {
    effects: [{ kind: 'delete', collection: 'tasks', id: task.id, revision }, parent.effect, owner.effect],
    result: { data: { id: task.id, cardId: card.id, checklist: parent.position, cardRevision: owner.revision } },
    audit: taskAudit('tasks.delete', task.id), events: checklistEvent(card, owner.revision),
  };
}
