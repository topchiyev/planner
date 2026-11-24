import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { workspaceKey } from '../../storage/identity.js';
import { CleanCommandRejection } from '../command-gate/gate.js';
import type { PlannedEffect } from '../command-journal/operation.js';
import { requireCapability, WorkspaceAccessError, type BoardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { canonicalRow, equal, publicIdField, type WorkspaceRecords, type WorkspaceRow } from './records.js';

const failures = {
  cardOrder: [409, 'CARD_ORDER_CONFLICT', 'The card order changed. Review the current list and try again.'],
  cardType: [422, 'CARD_TYPE_RESTRICTED', 'This board does not allow the selected card type.'],
  cardDue: [422, 'CARD_DUE_DATE_REQUIRED', 'Set a due date before changing its completion.'],
  cardStopwatch: [422, 'CARD_STOPWATCH_STATE', 'The stopwatch cannot make that change in its current state.'],
  duplicate: [409, 'RELATIONSHIP_EXISTS', 'This affiliation already exists.'],
  stale: [409, 'REVISION_CONFLICT', 'This affiliation or project changed. Reload and try again.'],
  lastManager: [409, 'LAST_PROJECT_MANAGER', 'Keep at least one project manager.'],
  projectNotEmpty: [409, 'PROJECT_NOT_EMPTY', 'Remove all boards before deleting this project.'],
  projectName: [422, 'PROJECT_NAME_MISMATCH', 'Enter the project name exactly as displayed.'],
  projectPlacement: [409, 'PROJECT_PLACEMENT', 'Planner could not append this project to the current order.'],
  boardOrder: [409, 'BOARD_ORDER_CONFLICT', 'The board order changed. Reload and try again.'],
  listOrder: [409, 'LIST_ORDER_CONFLICT', 'The list order changed. Reload and try again.'],
  listAnchor: [422, 'INVALID_LIST_ANCHOR', 'Choose a different list as the destination.'],
  boardDeleteData: [422, 'BOARD_DELETE_DATA_LIMIT', 'This board has imported data too large to preserve during deletion.'],
  boardName: [422, 'BOARD_NAME_MISMATCH', 'Enter the board name exactly as displayed.'],
  background: [422, 'INVALID_PROJECT_BACKGROUND', 'Choose an available image from this project.'],
  ownership: [409, 'OWNER_REQUIRES_SOLE_MANAGER', 'A private project requires one active eligible project manager.'],
  target: [422, 'INELIGIBLE_ACCOUNT', 'This account is unavailable for the selected affiliation.'],
  role: [422, 'INVALID_MEMBER_ROLE', 'The comment permission must match the board role.'],
} as const;

export class RelationshipError extends CleanCommandRejection {
  readonly statusCode: number;
  readonly code: string;

  constructor(kind: keyof typeof failures) {
    const [statusCode, code, message] = failures[kind];
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const managerRoles = ['admin', 'projectOwner'] as const;
export const memberRoles = [...managerRoles, 'boardUser'] as const;

export function availableAccount(user: WorkspaceRow<'users'> | null, kind: 'manager' | 'member') {
  return !!user && user.disabledAt === null && (kind === 'manager'
    ? managerRoles.some((role) => role === user.role) : memberRoles.some((role) => role === user.role));
}

export function projectFavoriteFilter(generationId: string, projectId: string, userId: string) {
  return { projectId, userId,
    $expr: { $and: [canonicalRow(generationId), equal('projectId', projectId), equal('userId', userId)] } };
}

export function projectManagerFilter(generationId: string, projectId: string) {
  return { projectId, $expr: { $and: [equal('projectId', projectId), canonicalRow(generationId), publicIdField('userId')] } };
}

export function managerEdges(records: WorkspaceRecords, generationId: string, projectId: string) {
  return records.aggregate<{ id: string; userId: string }>('projectManagers', projectManagerFilter(generationId, projectId),
    [{ $limit: 2 }, { $project: { _id: 0, id: 1, userId: 1 } }]);
}

export async function soleEligibleManager(records: WorkspaceRecords, generationId: string, projectId: string) {
  const edges = await managerEdges(records, generationId, projectId);
  return edges.length === 1 && availableAccount(await records.get('users', edges[0].userId), 'manager') ? edges[0] : null;
}

export function requireBoardManagement(scope: WorkspaceAuthorization, board: BoardAccessContext, targetId?: string) {
  requireCapability(board.permissions.canManage && (targetId === undefined || scope.roles.canCreateProject || targetId === scope.actor.id));
}

export function memberPermissions(role: 'viewer' | 'editor', canComment: boolean | null | undefined, previous = false) {
  if (role === 'editor') {
    if (typeof canComment === 'boolean') throw new RelationshipError('role');
    return { role, canComment: null };
  }
  if (canComment === null) throw new RelationshipError('role');
  return { role, canComment: canComment ?? previous };
}

export function rowRevision(row: { _id: string; id: string; generationId: string; revision?: number }) {
  if (!publicIdSchema.safeParse(row.id).success || row._id !== workspaceKey(row.generationId, row.id)) {
    throw new WorkspaceAccessError('missing');
  }
  if (!Object.hasOwn(row, 'revision')) return null;
  const revision = revisionSchema.safeParse(row.revision);
  if (!revision.success) throw new RelationshipError('stale');
  return revision.data;
}

export function requireRevision(row: Parameters<typeof rowRevision>[0], expected: number | null, update = false) {
  const revision = rowRevision(row);
  if (revision !== expected || (update && !revisionSchema.safeParse((revision ?? 0) + 1).success)) {
    throw new RelationshipError('stale');
  }
  return revision;
}

export function touchRevision(
  collection: 'projects' | 'boards' | 'lists' | 'cards' | 'checklists', row: Parameters<typeof rowRevision>[0] & { revision: number },
  timestamp: string, expected = row.revision,
): Extract<PlannedEffect, { kind: 'update' }> & { revision: number } {
  const revision = requireRevision(row, expected, true)!;
  return { kind: 'update', collection, id: row.id, revision, fields: { updatedAt: timestamp } };
}
