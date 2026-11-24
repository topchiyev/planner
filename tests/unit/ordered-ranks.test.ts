import assert from 'node:assert/strict';
import test from 'node:test';
import { maximumSignedInt64, minimumSignedInt64 } from '@planner/contracts/storage';
import { planRankChange, RankAnchorError } from '../../apps/backend/src/application/workspace/ordered-ranks.js';

test('placement resolves the neighbor after removing the moving row and preserves unaffected ranks', () => {
  const rows = [{ id: 'a', rank: -10n }, { id: 'b', rank: -5n }, { id: 'c', rank: 6n }, { id: 'd', rank: 15n }];
  assert.deepEqual(planRankChange(rows, 'b', 'd'), [{ id: 'b', rank: 10n }]);
  assert.deepEqual(planRankChange(rows, 'a', 'b'), []);
  assert.deepEqual(planRankChange(rows, 'd', null), []);
  assert.deepEqual(planRankChange(rows, 'new', null), [{ id: 'new', rank: 1039n }]);
  assert.throws(() => planRankChange(rows, 'b', 'b'), RankAnchorError);
  assert.throws(() => planRankChange(rows, 'b', 'missing'), RankAnchorError);
});

test('dense, legacy-null and signed 64-bit bounds renumber in the original stable order', () => {
  for (const [rows, before] of [
    [[{ id: 'a', rank: 2n }, { id: 'b', rank: 3n }], 'b'],
    [[{ id: 'a', rank: null }, { id: 'b', rank: 3n }], 'b'],
    [[{ id: 'a', rank: minimumSignedInt64 }, { id: 'b', rank: 3n }], 'a'],
    [[{ id: 'a', rank: 3n }, { id: 'b', rank: maximumSignedInt64 }], null],
  ] as const) {
    const update = planRankChange(rows, 'new', before);
    const order = before === 'a' ? ['new', 'a', 'b'] : before === 'b' ? ['a', 'new', 'b'] : ['a', 'b', 'new'];
    assert.deepEqual(update, order.map((id, index) => ({ id, rank: BigInt(index + 1) * 1024n })));
  }
  assert.deepEqual(planRankChange([{ id: 'a', rank: maximumSignedInt64 - 1n }], 'new', null),
    [{ id: 'new', rank: maximumSignedInt64 }]);
});
