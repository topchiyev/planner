import type { RelationshipCommandInput } from '@planner/contracts';
import { maximumSignedInt64, utcInstantSchema } from '@planner/contracts/storage';
import { decodeRank, isStoredDate } from '../../storage/identity.js';
import type { WorkspaceRow } from './records.js';
import { RelationshipError } from './relationship-policy.js';

type SortInput = Pick<RelationshipCommandInput<'lists.sort'>, 'field' | 'direction'>;
type SortableCard = Pick<WorkspaceRow<'cards'>, 'id' | 'name' | 'dueDate' | 'createdAt' | 'rank'>;

function foldedName(name: string) {
  let key = '';
  for (const char of name.normalize('NFD')) {
    if (char === 'ı') key += char;
    else if (/[\u13a0-\u13ff\uab70-\uabbf]/u.test(char)) key += char.toUpperCase();
    else key += char.toLowerCase().toUpperCase().toLowerCase().replaceAll('ς', 'σ');
  }
  return Buffer.from(key.normalize('NFD'));
}

function instant(value: Date | string | null | undefined) {
  if (isStoredDate(value)) return value.valueOf();
  const legacy = utcInstantSchema.safeParse(value);
  return legacy.success ? Date.parse(legacy.data) : null;
}

function orderById(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function planSortedCardRanks<T extends SortableCard>(cards: readonly T[], { field, direction }: SortInput) {
  const sign = direction === 'asc' ? 1 : -1;
  const rows = cards.map((card) => ({
    card, name: field === 'name' ? foldedName(card.name) : null,
    date: field === 'name' ? null : instant(card[field]),
    rank: card.rank == null ? null : decodeRank(card.rank),
  }));
  const sorted = rows.slice().sort((a, b) => {
    if (a.name && b.name) return sign * Buffer.compare(a.name, b.name) || orderById(a.card.id, b.card.id);
    // Missing dates always sort last. IDs break ties in the same ascending order in both directions.
    if (a.date === null || b.date === null) return Number(a.date === null) - Number(b.date === null) || orderById(a.card.id, b.card.id);
    return sign * (a.date - b.date) || orderById(a.card.id, b.card.id);
  });
  if (sorted.every((row, index) => row === rows[index])) return [];
  let previous: bigint | null = null;
  const slots = rows.every(({ rank }) => {
    if (rank === null || (previous !== null && rank <= previous)) return false;
    previous = rank;
    return true;
  });
  return sorted.flatMap(({ card, rank }, index) => {
    const next = slots ? rows[index].rank! : (BigInt(index) + 1n) * 1024n;
    if (next > maximumSignedInt64) throw new RelationshipError('cardOrder');
    return next === rank ? [] : [{ card, rank: next }];
  });
}
