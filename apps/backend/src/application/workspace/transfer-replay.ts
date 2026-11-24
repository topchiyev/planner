import { publicIdSchema } from '@planner/contracts/storage';
import type { RelationshipCommand } from '@planner/contracts';
import type { JournalValue } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { together } from './records.js';

type Capability = 'edit' | 'duplicate' | 'follow';
type Binding = { boardId: string; capability: Capability };

const object = (value: JournalValue | undefined) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

function add(bindings: Binding[], board: BoardAccessContext['board'], capability: Capability = 'edit') {
  if (!bindings.some((entry) => entry.boardId === board.id && entry.capability === capability)) bindings.push({ boardId: board.id, capability });
}

export async function captureTransferReplay(scope: WorkspaceAuthorization, operation: RelationshipCommand, normalized: JournalValue): Promise<Binding[] | undefined> {
  const request = object(normalized);
  if (!request || typeof request.id !== 'string') return undefined;
  const id = request.id;
  const bindings: Binding[] = [];
  if (operation === 'cards.create' || operation === 'lists.update' || operation === 'lists.move' || operation === 'lists.delete'
      || operation === 'lists.sort' || operation === 'lists.archiveCards') {
    add(bindings, (await scope.requireList(id)).board.board);
    if (operation === 'lists.move' && typeof request.toBoardId === 'string') add(bindings, (await scope.requireBoard(request.toBoardId)).board);
  } else if (operation.startsWith('cards.')) {
    const source = await scope.requireCard(id);
    const capability = operation === 'cards.duplicate' ? 'duplicate' : operation === 'cards.follow' || operation === 'cards.unfollow' ? 'follow' : 'edit';
    add(bindings, source.board.board, capability);
    if ((operation === 'cards.move' || operation === 'cards.duplicate') && typeof request.toListId === 'string') {
      add(bindings, (await scope.requireList(request.toListId)).board.board);
    }
  } else if (operation.startsWith('checklists.') || operation.startsWith('tasks.')) {
    const context = operation === 'checklists.create' ? await scope.requireCard(id)
      : operation.startsWith('checklists.') || operation === 'tasks.create' ? (await scope.requireChecklist(id)).card
        : (await scope.requireTask(id)).card;
    add(bindings, context.board.board);
  } else if (operation === 'fields.setValue' || operation === 'fields.clearValue' || (operation === 'fields.createGroup' && request.scopeType === 'card')) {
    add(bindings, (await scope.requireCard(id)).board.board);
  } else if (operation === 'fields.create' || operation === 'fields.update' || operation === 'fields.delete'
      || operation === 'fields.updateGroup' || operation === 'fields.deleteGroup' || operation === 'fields.detachGroup' || operation === 'fields.promoteGroup') {
    const group = operation === 'fields.update' || operation === 'fields.delete' ? await scope.requireFieldDefinition(id) : await scope.requireFieldGroup(id);
    if (group.scope === 'card') add(bindings, group.board.board);
    if (group.scope === 'board') add(bindings, group.board);
  }
  return bindings.length ? bindings : undefined;
}

function readBinding(value: JournalValue): Binding {
  const input = object(value);
  const id = publicIdSchema.safeParse(input?.boardId);
  const capability = input?.capability;
  if (!id.success || (capability !== 'edit' && capability !== 'duplicate' && capability !== 'follow')) {
    throw new WorkspaceAccessError('missing');
  }
  return { boardId: id.data, capability };
}

function requiredId(value: JournalValue | undefined) {
  const id = publicIdSchema.safeParse(value);
  if (!id.success) throw new WorkspaceAccessError('missing');
  return id.data;
}

async function assertResultScope(scope: WorkspaceAuthorization, operation: RelationshipCommand, data: ReturnType<typeof object>) {
  if (operation === 'cards.create' || operation === 'cards.duplicate') {
    await scope.requireCard(requiredId(object(data?.card)?.id));
  } else if (operation === 'lists.create') {
    await scope.requireList(requiredId(object(data?.list)?.id));
  } else if (operation === 'fields.promoteGroup') {
    const result = object(data?.group);
    const template = await scope.requireFieldGroup(requiredId(result?.id));
    if (template.scope !== 'project' || template.project.id !== result?.scopeId) throw new WorkspaceAccessError('missing');
  }
}

async function transferredLegacySubject(scope: WorkspaceAuthorization, operation: RelationshipCommand,
  request: ReturnType<typeof object>, data: ReturnType<typeof object>) {
  if (!request || typeof request.id !== 'string') return false;
  const { id } = request;
  if (operation.startsWith('cards.') && operation !== 'cards.create') return (await scope.requireCard(id)).card.transferredAcrossBoards === true;
  if (operation === 'cards.create' || operation === 'lists.update' || operation === 'lists.move'
      || operation === 'lists.sort' || operation === 'lists.archiveCards') return (await scope.requireList(id)).list.transferredAcrossBoards === true;
  if (operation === 'lists.delete') return false; // The stored board is already checked by the terminal deletion admission.
  if (operation === 'checklists.delete' || operation === 'tasks.delete') {
    return (await scope.requireCard(requiredId(data?.cardId))).card.transferredAcrossBoards === true;
  }
  if (operation === 'checklists.create' || operation === 'fields.setValue' || operation === 'fields.clearValue'
      || (operation === 'fields.createGroup' && request.scopeType === 'card')) {
    return (await scope.requireCard(id)).card.transferredAcrossBoards === true;
  }
  if (operation.startsWith('checklists.') || operation === 'tasks.create') {
    return (await scope.requireChecklist(id)).card.card.transferredAcrossBoards === true;
  }
  if (operation.startsWith('tasks.')) return (await scope.requireTask(id)).card.card.transferredAcrossBoards === true;
  if (operation === 'fields.deleteGroup') {
    return data?.scopeType === 'card' && (await scope.requireCard(requiredId(data.scopeId))).card.transferredAcrossBoards === true;
  }
  if (operation === 'fields.create' || operation === 'fields.update' || operation === 'fields.delete'
      || operation === 'fields.updateGroup' || operation === 'fields.detachGroup' || operation === 'fields.promoteGroup') {
    const group = operation === 'fields.update' ? await scope.requireFieldDefinition(id)
      : await scope.requireFieldGroup(operation === 'fields.delete' ? requiredId(data?.groupId) : id);
    return group.scope === 'card' && group.card.transferredAcrossBoards === true;
  }
  return false;
}

export async function authorizeTransferReplay(scope: WorkspaceAuthorization, operation: RelationshipCommand,
  replayScope: JournalValue | null, request: JournalValue, result: JournalValue) {
  const data = object(object(result)?.data);
  await assertResultScope(scope, operation, data);
  let bindings: Binding[];
  if (replayScope !== null) {
    if (!Array.isArray(replayScope) || !replayScope.length) throw new WorkspaceAccessError('missing');
    bindings = replayScope.map(readBinding);
  } else {
    // Older receipts carry their public board or placement identity. Prove that scope without trusting the card's new location.
    const placement = operation.startsWith('cards.') || operation.startsWith('lists.');
    const ids = [data?.boardId, object(data?.card)?.boardId, object(data?.list)?.boardId]
      .filter((id): id is string => placement && publicIdSchema.safeParse(id).success);
    if (!ids.length && await transferredLegacySubject(scope, operation, object(request), data)) throw new WorkspaceAccessError('missing');
    bindings = [...new Set(ids)].map((boardId) => ({ boardId, capability: 'edit' }));
    const positions = [object(data?.source)?.listId, object(data?.destination)?.listId]
      .filter((id): id is string => placement && publicIdSchema.safeParse(id).success);
    for (const id of new Set(positions)) add(bindings, (await scope.requireList(id)).board.board);
  }
  await together(bindings.map(async ({ boardId, capability }) => {
    const { permissions } = await scope.requireBoard(boardId);
    requireCapability(capability === 'edit' ? permissions.canEdit : capability === 'duplicate' ? permissions.canDuplicateFrom : permissions.canFollow);
  }));
}
