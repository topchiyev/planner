import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlan, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type WorkspaceAuthorization } from './authorization.js';
import { fieldGroupOrder, type FieldGroup, type FieldScope } from './field-state.js';
import { planRankChange, RankAnchorError } from './ordered-ranks.js';
import { canonicalRow, equal, together, type WorkspaceRecords, type WorkspaceRow } from './records.js';
import { RelationshipError, touchRevision } from './relationship-policy.js';

type Board = WorkspaceRow<'boards'>;
type Card = WorkspaceRow<'cards'>;
export type FieldOwner = { projectId: string; boardId: string | null } & (
  { collection: 'projects'; row: WorkspaceRow<'projects'> }
  | { collection: 'boards'; row: Board }
  | { collection: 'cards'; row: Card }
);
export type GroupEdit = { group: FieldGroup; owner: FieldOwner };

export async function authorizeFieldOwner(access: WorkspaceAuthorization, scopeType: FieldScope, id: string): Promise<FieldOwner> {
  if (scopeType === 'project') {
    const { project, permissions } = await access.requireProject(id);
    requireCapability(permissions.canEdit);
    return { collection: 'projects', row: project, projectId: id, boardId: null };
  }
  if (scopeType === 'board') {
    const { board, permissions } = await access.requireBoard(id);
    requireCapability(permissions.canEdit);
    return { collection: 'boards', row: board, projectId: board.projectId, boardId: id };
  }
  const { card, board, permissions } = await access.requireCard(id);
  requireCapability(permissions.canEdit);
  return { collection: 'cards', row: card, projectId: board.project.project.id, boardId: board.board.id };
}

export async function authorizeGroupEdit(access: WorkspaceAuthorization, id: string): Promise<GroupEdit> {
  const { group } = await access.requireFieldGroup(id);
  return { group, owner: await authorizeFieldOwner(access, group.scopeType, group.scopeId) };
}

export async function authorizeDefinitionEdit(access: WorkspaceAuthorization, id: string, groupId: string) {
  const { definition, group } = await access.requireFieldDefinition(id);
  if (group.id !== groupId) throw new WorkspaceAccessError('missing');
  return { definition, group, owner: await authorizeFieldOwner(access, group.scopeType, group.scopeId) };
}

export function nextFieldOrder(current: number) {
  const next = revisionSchema.safeParse(current + 1);
  if (!next.success) throw new RelationshipError('fieldOrder');
  return next.data;
}

export function changeFieldOwner(owner: FieldOwner, timestamp: string, reorder = false) {
  const effect = touchRevision(owner.collection, owner.row, timestamp);
  const old = fieldGroupOrder(owner.row);
  const orderVersion = reorder ? nextFieldOrder(old) : old;
  return { effect: { ...effect, fields: { ...effect.fields, fieldGroupOrderVersion: orderVersion } },
    revision: effect.revision + 1, orderVersion };
}

export function placeField<K extends 'fieldGroups' | 'fieldDefinitions'>(collection: K, rows: WorkspaceRow<K>[],
  id: string, placement: { before?: string | null; version?: number }, current: number, timestamp: string, create = false) {
  const { before, version } = placement;
  if ((before !== undefined || version !== undefined) && current !== version) throw new RelationshipError('fieldOrder');
  const effects: PlannedEffect[] = [];
  if (!create && before === undefined) return { effects, reordered: false, rank: undefined };
  let ranks: ReturnType<typeof planRankChange>;
  try {
    ranks = planRankChange(rows.map((row) => ({ id: row.id, rank: row.rank == null ? null : decodeRank(row.rank) })), id, before ?? null);
  } catch (error) {
    if (error instanceof RankAnchorError) throw new RelationshipError('fieldOrder');
    throw error;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  let rank: string | undefined;
  for (const change of ranks) {
    if (change.id === id) rank = change.rank.toString();
    else {
      const touch = touchRevision(collection, byId.get(change.id)!, timestamp);
      effects.push({ ...touch, fields: { ...touch.fields, rank: change.rank.toString() } });
    }
  }
  return { effects, reordered: ranks.length > 0, rank };
}

export async function projectFieldBoards(records: WorkspaceRecords, generationId: string, projectId: string) {
  return records.find('boards', { projectId, $expr: { $and: [canonicalRow(generationId), equal('projectId', projectId)] } }, { id: 1 });
}

function placedCards(records: WorkspaceRecords, generationId: string, boardId: string, cardIds?: string[]) {
  return records.aggregate<Card>('cards', { boardId, ...(cardIds && { id: { $in: cardIds } }),
    $expr: { $and: [canonicalRow(generationId), equal('boardId', boardId)] } }, [
    records.lookup('lists', 'placement', { listId: '$listId', cardKind: '$kind' }, { boardId, $expr: { $and: [
      canonicalRow(generationId), equal('boardId', boardId), { $eq: ['$id', '$$listId'] },
      { $or: [
        { $and: [{ $eq: ['$$cardKind', 'board'] }, { $in: ['$kind', ['active', 'closed']] }] },
        { $and: [{ $in: ['$kind', ['archive', 'trash']] }, { $eq: ['$kind', '$$cardKind'] }] },
      ] },
    ] } }, [{ $limit: 1 }]),
    { $match: { 'placement.0': { $exists: true } } }, { $sort: { id: 1 } }, { $unset: 'placement' },
  ]);
}

export async function ownedFieldCards(records: WorkspaceRecords, group: FieldGroup, boardId: string | null, cardIds: string[]) {
  if (!boardId || group.scopeType === 'project' || !cardIds.length) return [];
  return placedCards(records, group.generationId, boardId, group.scopeType === 'card' ? cardIds.filter((id) => id === group.scopeId) : cardIds);
}

export async function templateInstances(records: WorkspaceRecords, generationId: string, template: FieldGroup) {
  const boards = await projectFieldBoards(records, generationId, template.scopeId);
  const cards = new Map<string, Card>();
  for (const board of boards) {
    for (const card of await placedCards(records, generationId, board.id)) cards.set(card.id, card);
  }
  const matchTemplate = [canonicalRow(generationId), equal('templateGroupId', template.id)];
  const groupsAt = (scopeType: 'card' | 'board', ids: string[]) => records.find('fieldGroups', {
    templateGroupId: template.id, scopeType, scopeId: { $in: ids },
    $expr: { $and: [...matchTemplate, equal('scopeType', scopeType), { $in: ['$scopeId', ids] }] },
  }, { id: 1 });
  const boardRows = new Map(boards.map((board) => [board.id, board]));
  const [boardGroups, cardGroups] = await together([
    groupsAt('board', [...boardRows.keys()]), groupsAt('card', [...cards.keys()]),
  ]);
  return [
    ...boardGroups.map((group): GroupEdit => ({ group, owner: { collection: 'boards', row: boardRows.get(group.scopeId)!,
      projectId: template.scopeId, boardId: group.scopeId } })),
    ...cardGroups.map((group): GroupEdit => {
      const row = cards.get(group.scopeId)!;
      return { group, owner: { collection: 'cards', row, projectId: template.scopeId, boardId: row.boardId } };
    }),
  ];
}

export function validTemplateChoice(template: FieldGroup | null, projectId: string): template is FieldGroup {
  return template?.scopeType === 'project' && template.scopeId === projectId && template.templateGroupId == null && typeof template.name === 'string';
}

export function fieldEvents(boardIds: Iterable<string>): NonNullable<CommandPlan['events']> {
  return [...new Set(boardIds)].sort().map((boardId) => ({ boardId, kind: 'board.invalidated', payload: {} }));
}

export async function affectedFieldBoards(records: WorkspaceRecords, generationId: string, owner: FieldOwner) {
  return owner.boardId ? [owner.boardId] : (await projectFieldBoards(records, generationId, owner.projectId)).map(({ id }) => id);
}

export const fieldAudit = (action: string, id: string, resourceType: 'fieldGroup' | 'fieldDefinition' | 'card' = 'fieldGroup') =>
  ({ action, resourceId: id, resourceType });

export function missingField(): never { throw new WorkspaceAccessError('missing'); }
