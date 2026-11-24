import type { WorkspaceReadInput } from '@planner/contracts';
import type { Document } from 'mongodb';
import type { CursorScope } from '../pagination/cursor.js';
import { decodeRank } from '../../storage/identity.js';
import type { BoardAccessContext, WorkspaceAuthorization } from './authorization.js';
import { compileCardSearch, scanCardSearch } from './board-card-search.js';
import { cardFilters, cardPlacementStages, historyOrder, rankedOrder, readPage, type PagePosition } from './queries.js';
import type { WorkspaceRecords, WorkspaceRow } from './records.js';

type CardQuery = WorkspaceReadInput<'boardCards'>;
type Card = WorkspaceRow<'cards'> & { placement: WorkspaceRow<'lists'>[] };
type Position = Pick<Card, 'id' | 'rank' | 'historySequence' | 'listChangedAt'>;
type Measured = { counts: { listId: string; count: number }[]; pageRows: Position[] };

function empty(searchValidation: 'invalid-pattern' | 'search-limit') {
  return { selected: [] as Card[], counts: [], page: { nextCursor: null }, searchValidation };
}

export async function selectBoardCards(records: WorkspaceRecords, access: WorkspaceAuthorization, board: BoardAccessContext,
  input: CardQuery) {
  const search = compileCardSearch(input.q);
  if (!search.valid) return empty('invalid-pattern');
  const { actor, generationId } = access;
  const { id, context } = input;
  const ordinary = context === 'board';
  const scope: CursorScope = { generationId, actorId: actor.id, operation: 'boards.cards', order: ordinary ? 'rank-id' : 'history-id',
    query: [actor.role, board.membership?.role ?? '', String(!!board.project.manager), String(board.project.sharedAdmin),
      id, context, search.binding, JSON.stringify(input.labelsAny), JSON.stringify(input.labelsNone), JSON.stringify(input.members),
      JSON.stringify(input.listIds), String(input.unassigned), String(input.limit)] };
  const pager = readPage(ordinary ? rankedOrder : historyOrder, scope, input.limit, input.cursor);
  const filter: Document = { boardId: id, kind: context };
  if (input.listIds.length) filter.listId = { $in: input.listIds };
  const placement = cardPlacementStages(records, generationId, id, context);
  const selection = [...placement, ...await cardFilters(records, access, board, input)];
  if (search.match) {
    const matches = await scanCardSearch(records, filter, selection, search.match);
    if (!matches) return empty('search-limit');
    if (!matches.length) return { ...empty('search-limit'), searchValidation: 'ok' as const };
    filter.id = { $in: matches };
  }
  // Facet only small position records. Descriptions and long imported names never accumulate in a single BSON document.
  const [measured] = await records.aggregate<Measured>('cards', filter, [
    ...selection,
    { $facet: {
      counts: [
        { $group: { _id: '$listId', count: { $sum: 1 } } }, { $sort: { _id: 1 } },
        { $project: { _id: 0, listId: '$_id', count: 1 } },
      ],
      pageRows: [...pager.stages, { $project: { _id: 0, id: 1, rank: 1, historySequence: 1, listChangedAt: 1 } }],
    } },
  ]);
  const rank = (value: Position['rank']) => value == null ? null : decodeRank(value).toString();
  const { selected: positions, page } = pager.result(measured?.pageRows ?? [], (row): PagePosition => ordinary
    ? { rank: rank(row.rank), id: row.id }
    : { listChangedAt: row.listChangedAt?.toISOString() ?? null, historySequence: rank(row.historySequence), id: row.id });
  if (!positions.length) return { selected: [] as Card[], page, counts: measured?.counts ?? [], searchValidation: 'ok' as const };
  const cards = await records.aggregate<Card>('cards', { ...filter, id: { $in: positions.map(({ id }) => id) } }, placement);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const selected = positions.map(({ id }) => {
    const card = byId.get(id);
    if (!card) throw new Error('A selected card changed within its read snapshot.');
    return card;
  });
  return { selected, page, counts: measured?.counts ?? [], searchValidation: 'ok' as const };
}
