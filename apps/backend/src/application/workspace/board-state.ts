import type { BoardAccess } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import type { BoardAccessContext } from './authorization.js';
import { canonicalRow, equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';

export function boardShape(board: Pick<WorkspaceRow<'boards'>, 'id' | 'projectId' | 'name' | 'revision' | 'createdAt' | 'updatedAt' | 'rank'>,
  permissions: BoardAccess) {
  return {
    id: board.id, projectId: board.projectId, name: board.name, revision: board.revision,
    createdAt: board.createdAt.toISOString(), updatedAt: board.updatedAt?.toISOString() ?? null,
    rank: board.rank == null ? null : decodeRank(board.rank).toString(), permissions,
  };
}

export const boardDto = ({ board, permissions }: BoardAccessContext) => boardShape(board, permissions);

export function boardPreferencesRow(records: WorkspaceRecords, generationId: string, boardId: string) {
  return records.first('boardPreferences', { boardId, $expr: { $and: [canonicalRow(generationId), equal('boardId', boardId)] } });
}

export function boardPreferences(board: Pick<WorkspaceRow<'boards'>, 'defaultView'>, row?: WorkspaceRow<'boardPreferences'> | null) {
  return {
    revision: row?.revision ?? null, defaultView: row?.defaultView ?? board.defaultView ?? 'kanban',
    defaultCardType: row?.defaultCardType ?? null, restrictedCardType: row?.restrictedCardType ?? null,
    showCreator: row?.showCreator ?? false, showCardAge: row?.showCardAge ?? false,
    showCardCount: row?.showCardCount ?? false, expandChecklists: row?.expandChecklists ?? false,
  } as const;
}

export function projectBoardOrderVersion(project: Pick<WorkspaceRow<'projects'>, 'boardOrderVersion'>) {
  return revisionSchema.parse(project.boardOrderVersion ?? 1);
}
