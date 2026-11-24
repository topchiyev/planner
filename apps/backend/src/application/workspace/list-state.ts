import { finiteListKindSchema, listColorSchema } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import type { WorkspaceRow } from './records.js';

export function boardListOrderVersion(board: Pick<WorkspaceRow<'boards'>, 'orderVersion'>) {
  return revisionSchema.parse(board.orderVersion ?? 1);
}

export function listCardOrderVersion(list: Pick<WorkspaceRow<'lists'>, 'orderVersion' | 'revision'>) {
  return revisionSchema.parse(list.orderVersion ?? list.revision);
}

export function listDto(list: Pick<WorkspaceRow<'lists'>, 'id' | 'boardId' | 'name' | 'kind' | 'revision'
  | 'orderVersion' | 'rank' | 'color' | 'createdAt' | 'updatedAt'>) {
  const finite = finiteListKindSchema.safeParse(list.kind).success;
  return {
    id: list.id, boardId: list.boardId, name: list.name, kind: list.kind, revision: list.revision,
    rank: list.rank == null ? null : decodeRank(list.rank).toString(),
    color: finite ? listColorSchema.safeParse(list.color).data ?? null : null,
    orderVersion: listCardOrderVersion(list), createdAt: list.createdAt.toISOString(), updatedAt: list.updatedAt?.toISOString() ?? null,
  };
}
