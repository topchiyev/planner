import { labelColorSchema } from '@planner/contracts';
import { cardClosed } from '../workspace/card-state.js';
import type { WorkspaceRow } from '../workspace/records.js';
import { invalidBaseRow, targetTimes } from './base-fields.js';
import type { ImportOrder, ImportProvenance, ImportRecords, ImportReference } from './staged-records.js';
import type { SourceRow, SourceTable } from './source-projections.js';

export const workspaceRelationshipTables = [
  'base_custom_field_group', 'board_subscription', 'card_label', 'card_membership', 'card_subscription',
  'custom_field', 'custom_field_group', 'custom_field_value', 'label', 'project_favorite', 'task', 'task_list',
] as const;

export const relationshipRankTables = [
  'base_custom_field_group', 'custom_field', 'custom_field_group', 'label', 'task', 'task_list',
] as const;

type RelationshipTable = typeof workspaceRelationshipTables[number];
export function isWorkspaceRelationshipTable(table: SourceTable): table is RelationshipTable {
  return (workspaceRelationshipTables as readonly SourceTable[]).includes(table);
}
type Row<T extends RelationshipTable> = { table: T; row: SourceRow<T> };
export type WorkspaceRelationship = { [K in RelationshipTable]: Row<K> }[RelationshipTable];

function oneOwner(first: string | null, second: string | null, firstKind: string, secondKind: string) {
  if ((first === null) === (second === null)) invalidBaseRow('A source custom field record must have exactly one owning scope.');
  return first === null ? { parent: second!, kind: secondKind } : { parent: first, kind: firstKind };
}

function requireRank(rank: bigint | null) {
  if (rank === null || rank < 1n) invalidBaseRow('A source relationship has an invalid placement rank.');
  return rank;
}

function sourceName(value: string) {
  if (!value.trim() || value.includes('\0')) invalidBaseRow('A source relationship has an invalid name.');
  return value;
}

export async function reserveWorkspaceRelationship(store: ImportRecords, entry: WorkspaceRelationship, provenance: ImportProvenance) {
  const { table, row } = entry;
  let order: ImportOrder | undefined;
  let reference: ImportReference | undefined;
  switch (table) {
    case 'base_custom_field_group':
      reference = { parent: row.project_id, kind: 'project' };
      order = { parent: row.project_id, position: 0 };
      break;
    case 'custom_field_group':
      reference = oneOwner(row.board_id, row.card_id, 'board', 'card');
      order = { parent: reference.kind + ':' + reference.parent, position: row.position };
      break;
    case 'custom_field':
      reference = oneOwner(row.base_custom_field_group_id, row.custom_field_group_id, 'template', 'instance');
      order = { parent: reference.kind + ':' + reference.parent, position: row.position };
      break;
    case 'label':
      reference = { parent: row.board_id };
      order = { parent: row.board_id, position: row.position };
      break;
    case 'task_list':
      reference = { parent: row.card_id };
      order = { parent: row.card_id, position: row.position };
      break;
    case 'task':
      order = { parent: row.task_list_id, position: row.position };
      if (row.linked_card_id !== null) {
        provenance.linkedTask = {
          sourceCardId: row.linked_card_id, name: row.name, completed: row.is_completed,
          missingTarget: await store.resolve('card', row.linked_card_id) === null,
        };
      }
      break;
  }
  await store.reserve(table, row.id, provenance, order, reference);
}

async function cardBySource(store: ImportRecords, sourceId: string) {
  const card = await store.get('cards', await store.require('card', sourceId));
  if (!card) invalidBaseRow('An owning source card was not staged.');
  return card;
}

async function checkAssignee(store: ImportRecords, card: WorkspaceRow<'cards'>, sourceId: string) {
  const userId = await store.require('user_account', sourceId);
  if (!await store.eligibleBoardMember(card.boardId, userId)) {
    invalidBaseRow('A source assignment has no enabled direct member in its owning board.');
  }
  return userId;
}

async function linkedPlacement(store: ImportRecords, cardId: string) {
  const linked = await store.get('cards', cardId);
  if (!linked) invalidBaseRow('A reserved linked card was not staged.');
  const list = await store.get('lists', linked.listId);
  const expectedKind = list?.kind === 'active' || list?.kind === 'closed' ? 'board'
    : list?.kind === 'archive' || list?.kind === 'trash' ? list.kind : null;
  if (!list || list.boardId !== linked.boardId || expectedKind !== linked.kind
    || !await store.get('boards', linked.boardId)) invalidBaseRow('A linked card has invalid staged placement.');
  return { linkedCardId: cardId, linkedUnavailable: false, name: null, completed: cardClosed(linked, list) };
}

async function writeTask(store: ImportRecords, id: string, row: SourceRow<'task'>, fallback: string, rank: bigint) {
  const checklist = await store.mapping('task_list', row.task_list_id);
  if (!checklist?.reference) invalidBaseRow('A required source checklist is missing.');
  const card = await cardBySource(store, checklist.reference.parent);
  const assigneeId = row.assignee_user_id === null ? null : await checkAssignee(store, card, row.assignee_user_id);
  let link;
  if (row.linked_card_id === null) {
    link = { linkedCardId: null, linkedUnavailable: false, name: sourceName(row.name), completed: row.is_completed };
  } else {
    const target = await store.resolve('card', row.linked_card_id);
    link = target ? await linkedPlacement(store, target)
      : { linkedCardId: null, linkedUnavailable: true, name: null, completed: null };
  }
  await store.write('tasks', id, { ...targetTimes(row, fallback), ...link, checklistId: checklist.id, rank, assigneeId });
}

async function writeInstance(store: ImportRecords, id: string, row: SourceRow<'custom_field_group'>, fallback: string, rank: bigint) {
  const owner = oneOwner(row.board_id, row.card_id, 'board', 'card');
  const scopeType = owner.kind === 'board' ? 'board' : 'card';
  const card = scopeType === 'card' ? await cardBySource(store, owner.parent) : null;
  const boardId = card?.boardId ?? await store.require('board', owner.parent);
  const board = await store.get('boards', boardId);
  if (!board) invalidBaseRow('A source custom field instance has no staged board.');
  let templateGroupId: string | null = null;
  if (row.base_custom_field_group_id !== null) {
    templateGroupId = await store.require('base_custom_field_group', row.base_custom_field_group_id);
    const template = await store.get('fieldGroups', templateGroupId);
    if (!template || template.scopeType !== 'project' || template.scopeId !== board.projectId || template.templateGroupId !== null) {
      invalidBaseRow('A source custom field template belongs to a different project.');
    }
  }
  if (row.name === null && templateGroupId === null) invalidBaseRow('A source custom field group has no effective name.');
  await store.write('fieldGroups', id, { ...targetTimes(row, fallback), name: row.name === null ? null : sourceName(row.name),
    templateGroupId, scopeType, scopeId: card?.id ?? boardId, fieldOrderVersion: 1, rank });
}

async function writeValue(store: ImportRecords, id: string, row: SourceRow<'custom_field_value'>, fallback: string) {
  const card = await cardBySource(store, row.card_id);
  const fieldGroupId = await store.require('custom_field_group', row.custom_field_group_id);
  const fieldDefinitionId = await store.require('custom_field', row.custom_field_id);
  const group = await store.get('fieldGroups', fieldGroupId);
  const definition = await store.get('fieldDefinitions', fieldDefinitionId);
  const owner = group?.scopeType === 'board' ? card.boardId : group?.scopeType === 'card' ? card.id : null;
  if (!group || !owner || group.scopeId !== owner || !definition
    || (definition.fieldGroupId !== group.id && definition.fieldGroupId !== group.templateGroupId)) {
    invalidBaseRow('A source custom field value has an incompatible card, group or definition tuple.');
  }
  await store.write('fieldValues', id, { ...targetTimes(row, fallback), cardId: card.id, fieldGroupId,
    fieldDefinitionId, value: row.content });
}

export async function writeWorkspaceRelationship(store: ImportRecords, fallback: string, entry: WorkspaceRelationship, rank: bigint | null) {
  const { table, row } = entry;
  const id = store.publicId(table, row.id);
  const times = targetTimes(row, fallback);
  switch (table) {
    case 'project_favorite':
      return store.write('projectFavorites', id, { ...times, projectId: await store.require('project', row.project_id),
        userId: await store.require('user_account', row.user_id) });
    case 'board_subscription':
      return store.write('boardFollows', id, { ...times, boardId: await store.require('board', row.board_id),
        userId: await store.require('user_account', row.user_id) });
    case 'card_subscription':
      return store.write('cardFollows', id, { ...times, cardId: await store.require('card', row.card_id),
        userId: await store.require('user_account', row.user_id), isPermanent: row.is_permanent });
    case 'card_membership': {
      const card = await cardBySource(store, row.card_id);
      return store.write('cardAssignees', id, { ...times, cardId: card.id, userId: await checkAssignee(store, card, row.user_id) });
    }
    case 'card_label': {
      const card = await cardBySource(store, row.card_id);
      const label = await store.mapping('label', row.label_id);
      if (!label?.reference || await store.require('board', label.reference.parent) !== card.boardId) {
        invalidBaseRow('A source card label belongs to a different board.');
      }
      return store.write('cardLabels', id, { ...times, cardId: card.id, labelId: label.id });
    }
    case 'label': {
      const color = labelColorSchema.safeParse(row.color);
      if (!color.success) invalidBaseRow('A source label has an unsupported color.');
      return store.write('labels', id, { ...times, boardId: await store.require('board', row.board_id), rank: requireRank(rank),
        name: row.name === null ? null : sourceName(row.name), color: color.data });
    }
    case 'task_list':
      return store.write('checklists', id, { ...times, cardId: (await cardBySource(store, row.card_id)).id, rank: requireRank(rank),
        name: sourceName(row.name), showOnFront: row.show_on_front_of_card, hideCompleted: row.hide_completed_tasks, orderVersion: 1 });
    case 'task':
      return writeTask(store, id, row, fallback, requireRank(rank));
    case 'base_custom_field_group':
      return store.write('fieldGroups', id, { ...times, scopeType: 'project', scopeId: await store.require('project', row.project_id),
        name: sourceName(row.name), templateGroupId: null, fieldOrderVersion: 1, rank: requireRank(rank) });
    case 'custom_field_group':
      return writeInstance(store, id, row, fallback, requireRank(rank));
    case 'custom_field': {
      const owner = oneOwner(row.base_custom_field_group_id, row.custom_field_group_id, 'template', 'instance');
      const groupType = owner.kind === 'template' ? 'base_custom_field_group' : 'custom_field_group';
      return store.write('fieldDefinitions', id, { ...times, fieldGroupId: await store.require(groupType, owner.parent),
        name: sourceName(row.name), showOnFront: row.show_on_front_of_card, rank: requireRank(rank) });
    }
    case 'custom_field_value':
      return writeValue(store, id, row, fallback);
  }
}
