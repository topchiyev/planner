import { maximumSignedInt64, minimumSignedInt64 } from '@planner/contracts/storage';

export interface RankedRow {
  id: string;
  rank: bigint | null;
}

export class RankAnchorError extends Error {}

const step = 1024n;

function between(left: RankedRow | undefined, right: RankedRow | undefined) {
  const lower = left?.rank;
  const upper = right?.rank;
  if (lower === null || upper === null) return null;
  if (lower !== undefined && upper !== undefined) {
    return upper - lower > 1n ? lower + (upper - lower) / 2n : null;
  }
  if (lower !== undefined) {
    if (lower === maximumSignedInt64) return null;
    return lower + step <= maximumSignedInt64 ? lower + step : lower + 1n;
  }
  if (upper !== undefined) {
    if (upper === minimumSignedInt64) return null;
    return upper - step >= minimumSignedInt64 ? upper - step : upper - 1n;
  }
  return step;
}

/** Rows are in authorized application order. The moving ID may be new. */
export function planRankChange(rows: readonly RankedRow[], movingId: string, beforeId: string | null) {
  if (movingId === beforeId) throw new RankAnchorError();
  const originalIndex = rows.findIndex(({ id }) => id === movingId);
  if (originalIndex >= 0 && (rows[originalIndex + 1]?.id ?? null) === beforeId) return [];

  const rest = rows.filter(({ id }) => id !== movingId);
  const position = beforeId === null ? rest.length : rest.findIndex(({ id }) => id === beforeId);
  if (position < 0) throw new RankAnchorError();

  const rank = between(rest[position - 1], rest[position]);
  if (rank !== null) return [{ id: movingId, rank }];

  const original = new Map(rows.map((row) => [row.id, row.rank]));
  rest.splice(position, 0, { id: movingId, rank: null });
  return rest.flatMap(({ id }, index) => {
    const rank = BigInt(index + 1) * step;
    if (rank > maximumSignedInt64) throw new RangeError('The ordered collection cannot be ranked.');
    return rank === original.get(id) ? [] : [{ id, rank }];
  });
}
