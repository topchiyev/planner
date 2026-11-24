import { randomUUID } from 'node:crypto';
import { labelDeleteReceipt, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import { decodeRank, encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { readTerminalDeletionReceipt } from './deletion-receipt.js';
import { labelDto, scopedLabels } from './label-state.js';
import { boardListOrderVersion } from './list-state.js';
import { planRankChange } from './ordered-ranks.js';
import { RelationshipError, requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, publicIdField, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type LabelAccess = Awaited<ReturnType<WorkspaceAuthorization['requireLabel']>>;
type Board = WorkspaceRow<'boards'>;

export async function authorizePaletteBoard(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireBoard(id);
  requireCapability(access.permissions.canEdit);
  return access;
}

export async function authorizeLabelEdit(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireLabel(id);
  requireCapability(access.board.permissions.canEdit);
  return access;
}

export async function authorizeLabelDelete(database: Db, scope: WorkspaceAuthorization,
  input: RelationshipCommandInput<'labels.delete'>, key?: string,
) {
  try {
    return await authorizeLabelEdit(scope, input.id);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !key) throw error;
    const receipt = labelDeleteReceipt.safeParse(await readTerminalDeletionReceipt(database, scope, 'labels.delete', key, input));
    if (!receipt.success || receipt.data.data.id !== input.id) throw error;
    await authorizePaletteBoard(scope, receipt.data.data.boardId);
    return null;
  }
}

function paletteChange(board: Board, timestamp: string, expected = board.revision) {
  const effect = touchRevision('boards', board, timestamp, expected);
  return { ...effect, fields: { ...effect.fields, orderVersion: boardListOrderVersion(board) } };
}
const audit = (action: string, resourceId: string) => ({ action, resourceId, resourceType: 'label' });
const invalidation = (boardId: string) => ({ boardId, kind: 'board.invalidated', payload: {} });

export async function planLabelCreate(records: WorkspaceRecords, { board }: BoardAccessContext,
  { name, color, expectedRevision }: RelationshipCommandInput<'labels.create'>, { generationId, timestamp }: CommandPlanningContext,
): Promise<CommandPlan> {
  const parent = paletteChange(board, timestamp, expectedRevision);
  const links = await scopedLabels(records, generationId, board.id);
  const id = randomUUID();
  let changes: Map<string, bigint>;
  try {
    changes = new Map(planRankChange(links.map((label) => ({ id: label.id, rank: label.rank == null ? null : decodeRank(label.rank) })),
      id, null).map(({ id: changedId, rank }) => [changedId, rank]));
  } catch (error) {
    if (error instanceof RangeError) throw new RelationshipError('labelOrder');
    throw error;
  }
  const rank = changes.get(id);
  if (rank === undefined) throw new Error('An appended label requires a rank.');
  const fields = { boardId: board.id, name, color };
  const effects: PlannedEffect[] = [{ kind: 'insert', collection: 'labels', id,
    fields: { ...fields, rank: rank.toString(), createdAt: timestamp, updatedAt: null } }, parent];
  for (const label of links) {
    const changed = changes.get(label.id);
    if (changed === undefined) continue;
    const touch = touchRevision('labels', label, timestamp);
    effects.push({ ...touch, fields: { ...touch.fields, rank: changed.toString() } });
  }
  return {
    effects, result: { data: { label: labelDto({ ...fields, id, rank: encodeRank(rank), revision: 1, createdAt: new Date(timestamp) }),
      boardRevision: parent.revision + 1 } }, audit: audit('labels.create', id), events: [invalidation(board.id)],
  };
}

export async function planLabelUpdate(_records: WorkspaceRecords, { label, board: { board } }: LabelAccess,
  input: RelationshipCommandInput<'labels.update'>, { timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  requireRevision(label, input.expectedRevision);
  const fields = {
    ...(input.name !== undefined && input.name !== (label.name ?? null) && { name: input.name }),
    ...(input.color !== undefined && input.color !== label.color && { color: input.color }),
  };
  if (!Object.keys(fields).length) return {
    effects: [], result: { data: { label: labelDto(label), boardRevision: board.revision } }, audit: audit('labels.update', label.id),
  };
  const touch = touchRevision('labels', label, timestamp);
  const parent = paletteChange(board, timestamp);
  return {
    effects: [{ ...touch, fields: { ...touch.fields, ...fields } }, parent],
    result: { data: { label: labelDto({ ...label, ...fields, revision: touch.revision + 1, updatedAt: new Date(timestamp) }),
      boardRevision: parent.revision + 1 } },
    audit: audit('labels.update', label.id), events: [invalidation(board.id)],
  };
}

export async function planLabelDelete(records: WorkspaceRecords, access: LabelAccess | null,
  input: RelationshipCommandInput<'labels.delete'>, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  if (!access) throw new WorkspaceAccessError('missing');
  const { label, board: { board } } = access;
  const revision = requireRevision(label, input.expectedRevision);
  const canonical = canonicalRow(generationId);
  type Affected = WorkspaceRow<'cardLabels'> & { card: WorkspaceRow<'cards'> };
  const edges = await records.aggregate<Affected>('cardLabels', { labelId: label.id,
    $expr: { $and: [canonical, equal('labelId', label.id), publicIdField('cardId')] } }, [
    records.lookup('cards', 'card', { id: '$cardId' }, { boardId: board.id,
      $expr: { $and: [canonical, equal('boardId', board.id), { $eq: ['$id', '$$id'] }] } }, [{ $limit: 1 }]),
    { $unwind: '$card' }, { $sort: { id: 1 } },
  ]);
  const cards = new Map(edges.map(({ card }) => [card.id, card]));
  const effects: PlannedEffect[] = edges.map((edge) => ({
    kind: 'delete', collection: 'cardLabels', id: edge.id, revision: rowRevision(edge),
  }));
  for (const card of cards.values()) effects.push(touchRevision('cards', card, timestamp));
  const parent = paletteChange(board, timestamp);
  effects.push({ kind: 'delete', collection: 'labels', id: label.id, revision }, parent);
  return {
    effects, result: { data: { id: label.id, boardId: board.id, parentRevision: parent.revision + 1 } },
    audit: audit('labels.delete', label.id), events: [invalidation(board.id)],
  };
}
