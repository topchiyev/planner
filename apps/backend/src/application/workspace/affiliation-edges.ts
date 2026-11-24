import { canonicalRow, equal, publicIdField, together, type WorkspaceRecords } from './records.js';

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

export async function boardCardFollowers(records: WorkspaceRecords, generationId: string, boardId: string, cardId: string) {
  const followFilter = (field: 'boardId' | 'cardId', value: string) => ({
    [field]: value, $expr: { $and: [canonicalRow(generationId), equal(field, value), publicIdField('userId')] },
  });
  const [board, card] = await together([
    records.find('boardFollows', followFilter('boardId', boardId)),
    records.find('cardFollows', followFilter('cardId', cardId)),
  ]);
  return new Set([...board, ...card].map(({ userId }) => userId));
}
