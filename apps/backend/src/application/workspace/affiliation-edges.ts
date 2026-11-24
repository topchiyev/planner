import { canonicalRow, equal, type WorkspaceRecords } from './records.js';

type RelationFields = Partial<Record<'boardId' | 'cardId' | 'labelId' | 'userId', string>>;

export function affiliationFilter(generationId: string, fields: RelationFields) {
  return { ...fields, $expr: { $and: [
    canonicalRow(generationId),
    ...Object.entries(fields).map(([field, value]) => equal(field, value)),
  ] } };
}

export function personalFollow(records: WorkspaceRecords, generationId: string, parent: 'board' | 'card', id: string, userId: string) {
  return parent === 'board'
    ? records.first('boardFollows', affiliationFilter(generationId, { boardId: id, userId }))
    : records.first('cardFollows', affiliationFilter(generationId, { cardId: id, userId }));
}
