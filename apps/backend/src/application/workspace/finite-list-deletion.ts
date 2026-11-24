import { listDeleteReceipt, type RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type WorkspaceAuthorization } from './authorization.js';
import {
  boardHistoryChange, cardMovementActivity, cardsInPlacement, finiteList, historyArrival, listPlacementChange,
  previousPlacementProvenance, reserveCardHistory, scopedBoardInvalidation, scopedSystemList,
} from './card-history.js';
import { readTerminalDeletionReceipt } from './deletion-receipt.js';
import { boardListOrderVersion, listCardOrderVersion } from './list-state.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, type WorkspaceRecords } from './records.js';

type DeleteList = RelationshipCommandInput<'lists.delete'>;
type ListAccess = Awaited<ReturnType<WorkspaceAuthorization['requireList']>>;

export async function authorizeFiniteListDeletion(database: Db, scope: WorkspaceAuthorization, input: DeleteList, key?: string) {
  try {
    const access = await scope.requireList(input.id);
    requireCapability(access.board.permissions.canEdit && finiteList(access.list));
    return access;
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404 || !key) throw error;
    const receipt = listDeleteReceipt.safeParse(await readTerminalDeletionReceipt(database, scope, 'lists.delete', key, input));
    if (!receipt.success || receipt.data.data.id !== input.id) throw error;
    requireCapability((await scope.requireBoard(receipt.data.data.boardId)).permissions.canEdit);
    return null;
  }
}

export async function planFiniteListDeletion(records: WorkspaceRecords, access: ListAccess | null, input: DeleteList,
  context: CommandPlanningContext): Promise<CommandPlan> {
  if (!access) throw new WorkspaceAccessError('missing');
  const { list, board: { board } } = access;
  const { generationId, timestamp } = context;
  const revision = requireRevision(list, input.expectedRevision);
  const trash = await scopedSystemList(records, generationId, board.id, 'trash');
  if (boardListOrderVersion(board) !== input.boardOrderVersion || listCardOrderVersion(list) !== input.sourceOrderVersion
      || listCardOrderVersion(trash) !== input.trashOrderVersion) throw new RelationshipError('listOrder');

  const occupants = await cardsInPlacement(records, generationId, list, 'board');
  const history = await reserveCardHistory(records, generationId, board, occupants.length);
  const effects: PlannedEffect[] = [];
  if (history) {
    for (const [index, card] of occupants.entries()) {
      const touch = touchRevision('cards', card, timestamp);
      effects.push({ ...touch, fields: historyArrival(card, list, trash, 'trash', history.first + BigInt(index), null, timestamp) },
        cardMovementActivity(card, list, trash, context));
    }
    effects.push(listPlacementChange(trash, timestamp));
  }

  const archive = await scopedSystemList(records, generationId, board.id, 'archive');
  const dangling = await records.find('cards', { boardId: board.id, previousListId: list.id,
    $expr: { $and: [canonicalRow(generationId), equal('boardId', board.id), equal('previousListId', list.id),
      { $or: [{ $and: [equal('kind', 'archive'), equal('listId', archive.id)] },
        { $and: [equal('kind', 'trash'), equal('listId', trash.id)] }] }] } }, { id: 1 });
  for (const card of dangling) {
    const touch = touchRevision('cards', card, timestamp);
    effects.push({ ...touch, fields: { ...touch.fields, previousListId: null,
      ...previousPlacementProvenance(list.id, timestamp, 'removed') } });
  }
  const parent = boardHistoryChange(board, timestamp, history?.last, true);
  effects.push({ kind: 'delete', collection: 'lists', id: list.id, revision }, parent);
  return {
    effects,
    result: { data: { id: list.id, boardId: board.id, parentRevision: parent.revision + 1 } },
    audit: { action: 'lists.delete', resourceType: 'list', resourceId: list.id },
    events: [scopedBoardInvalidation(board.id)],
  };
}
