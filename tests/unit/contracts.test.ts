import assert from 'node:assert/strict';
import test from 'node:test';
import { healthOperations, PLANNER_VERSION } from '../../packages/contracts/src/index.ts';
import { workspaceIds } from '../fixtures/planner-workspace.ts';

test('health contracts are strict transport-neutral read descriptors', () => {
  const live = healthOperations.live;
  const readiness = healthOperations.readiness;
  assert.equal(live.id, 'health.live');
  assert.equal(readiness.id, 'health.readiness');
  for (const operation of Object.values(healthOperations)) {
    assert.equal(operation.kind, 'read');
    assert.deepEqual(operation.input.parse({}), {});
    assert.equal(operation.input.safeParse({ temporary: true }).success, false);
  }
  const response = { status: 'live', version: PLANNER_VERSION, requestId: workspaceIds.generation };
  assert.deepEqual(live.output.parse(response), response);
  assert.equal(readiness.output.safeParse(response).success, false);
  assert.equal(readiness.output.safeParse({ ...response, status: 'ready' }).success, true);
  assert.equal(readiness.output.safeParse({ ...response, status: 'unavailable' }).success, true);
  assert.equal(live.output.safeParse({ ...response, instructions: 'unexpected' }).success, false);
  assert.equal(live.output.safeParse({ ...response, requestId: 'not-a-uuid' }).success, false);
  assert.equal(live.output.safeParse({ ...response, version: '0.0.0' }).success, false);
});
