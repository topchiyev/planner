import type { CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import type { WorkspaceAuthorization } from './authorization.js';
import { planLinkedCardCompletion } from './linked-card-completion.js';
import { together, type WorkspaceRecords, type WorkspaceRow } from './records.js';
import { touchRevision } from './relationship-policy.js';
import { planCloneAttachments, planCloneChecklists, planMoveChecklistAssignees, planMoveComments, readTransferChecklists } from './transfer-children.js';
import { planTransferFields } from './transfer-fields.js';
import { planTransferLabels } from './transfer-labels.js';
import { planTransferPeople } from './transfer-members.js';

type Board = WorkspaceRow<'boards'>;
type Card = WorkspaceRow<'cards'>;

export function mergeTransferEffects(effects: PlannedEffect[]) {
  const planned = new Map<string, PlannedEffect>();
  for (const effect of effects) {
    const key = effect.collection + '/' + effect.id;
    const previous = planned.get(key);
    if (!previous) planned.set(key, effect);
    else {
      if (previous.kind !== 'update' || effect.kind !== 'update' || previous.revision !== effect.revision) {
        throw new Error('Conflicting effects in a card transfer.');
      }
      planned.set(key, { ...previous, fields: { ...previous.fields, ...effect.fields } });
    }
  }
  return [...planned.values()];
}

export async function planMoveCardGraph(records: WorkspaceRecords, source: Board, destination: Board,
  moved: { card: Card; completed: boolean }[], context: CommandPlanningContext) {
  const { generationId, timestamp } = context;
  const ids = moved.map(({ card }) => card.id);
  const transfers = ids.map((id) => ({ sourceId: id, destinationId: id }));
  const [checklists, labels, comments] = await together([
    readTransferChecklists(records, generationId, ids),
    planTransferLabels(records, source.id, destination.id, transfers, context, false),
    planMoveComments(records, source.id, destination.id, ids, context),
  ]);
  const people = await planTransferPeople(records, destination.id, transfers, checklists.tasks, context, false);
  const clearAssignees = planMoveChecklistAssignees(checklists.tasks, people.eligible, timestamp);
  const changedTaskIds = new Set(clearAssignees.map(({ id }) => id));
  const changedChecklists = new Set(checklists.tasks.filter(({ id }) => changedTaskIds.has(id)).map(({ checklistId }) => checklistId));
  const effects = [...labels.effects, ...comments, ...people.effects, ...clearAssignees,
    ...checklists.checklists.filter(({ id }) => changedChecklists.has(id)).map((row) => touchRevision('checklists', row, timestamp))];
  const invalidated = new Set<string>();
  const fieldOrderChanged = new Set<string>();
  let fieldGroupsMaterialized = 0;
  for (const [index, { card, completed }] of moved.entries()) {
    const [fields, links] = await together([
      planTransferFields(records, source, destination, transfers[index], context),
      planLinkedCardCompletion(records, generationId, { id: card.id, boardId: destination.id }, completed, timestamp),
    ]);
    fieldGroupsMaterialized += fields.materialized;
    if (fields.materialized) fieldOrderChanged.add(card.id);
    effects.push(...fields.effects, ...links.effects);
    for (const { boardId } of links.events) invalidated.add(boardId);
  }
  return { effects, invalidated, fieldOrderChanged,
    summary: { ...people.stats, labelsRemapped: labels.remapped, labelsCreated: labels.created, fieldGroupsMaterialized } };
}

export async function planDuplicateCardGraph(records: WorkspaceRecords, source: Board, destination: Board,
  card: Card, newCardId: string, scope: WorkspaceAuthorization, context: CommandPlanningContext) {
  const { generationId, timestamp } = context;
  const transfer = { sourceId: card.id, destinationId: newCardId };
  const [checklists, labels, attachments, fields] = await together([
    readTransferChecklists(records, generationId, [card.id]),
    planTransferLabels(records, source.id, destination.id, [transfer], context, true),
    planCloneAttachments(records, card, newCardId, context),
    planTransferFields(records, source, destination, transfer, context),
  ]);
  const people = await planTransferPeople(records, destination.id, [transfer], checklists.tasks, context, true);
  const children = await planCloneChecklists(checklists.checklists, checklists.tasks, newCardId, people.eligible, scope, timestamp);
  return { effects: [...labels.effects, ...attachments.effects, ...fields.effects, ...people.effects, ...children],
    coverAttachmentId: attachments.coverAttachmentId,
    summary: { ...people.stats, labelsRemapped: labels.remapped, labelsCreated: labels.created, fieldGroupsMaterialized: fields.materialized } };
}
