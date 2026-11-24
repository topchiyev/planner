import { decodeRank } from '../../storage/identity.js';
import { affiliationFilter } from './affiliation-edges.js';
import { canonicalRow, equal, publicIdField, rankSort, type WorkspaceRecords, type WorkspaceRow } from './records.js';

export function labelDto(row: Pick<WorkspaceRow<'labels'>, 'id' | 'boardId' | 'name' | 'color' | 'rank' | 'revision' | 'createdAt' | 'updatedAt'>) {
  return {
    id: row.id, boardId: row.boardId, name: row.name ?? null, color: row.color ?? null,
    rank: row.rank == null ? null : decodeRank(row.rank).toString(),
    revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export function scopedLabels(records: WorkspaceRecords, generationId: string, boardId: string, ids?: string[]) {
  return records.find('labels', { ...affiliationFilter(generationId, { boardId }), ...(ids && { id: { $in: ids } }) }, rankSort);
}

export function cardLabelJoinFilter(generationId: string, cardId: string, labelIds?: string[]) {
  return {
    ...(labelIds && { labelId: { $in: labelIds } }),
    $expr: { $and: [
      canonicalRow(generationId), equal('cardId', cardId), publicIdField('labelId'),
      ...(labelIds ? [{ $in: ['$labelId', labelIds] }] : []),
    ] },
  };
}
