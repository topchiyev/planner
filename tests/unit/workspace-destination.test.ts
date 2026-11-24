import assert from 'node:assert/strict';
import test from 'node:test';
import { boardFilterKeys, workspaceReturnPath, workspaceSignInPath } from '@planner/contracts';

const projectId = 'c0d7680f-1a44-4222-8b16-22c35e1be317';
const boardId = 'c0d7680f-1a44-4222-8b16-22c35e1be318';
const cardId = 'c0d7680f-1a44-4222-8b16-22c35e1be319';

test('workspace sign-in destinations retain authorized route shape and validated query fields', () => {
  const board = `/boards/${boardId}/cards/${cardId}`;
  assert.equal(workspaceReturnPath(board + '?view=grid&context=archive&token=foreign#fragment'), board + '?context=archive&view=grid');
  assert.equal(workspaceReturnPath(`/projects/${projectId}/`), `/projects/${projectId}`);
  const workspace = '/workspace?q=hello+Planner%2FTeams&hidden=include&favorite=true&cursor=v1.AB&open=' + projectId;
  assert.equal(workspaceReturnPath(workspace), workspace);
  assert.equal(workspaceReturnPath('/workspace?q=first&q=duplicate&hidden=unsupported&favorite=false'), '/workspace?favorite=false');
  assert.equal(workspaceSignInPath('/workspace'), '/sign-in');
  const redirect = new URL(workspaceSignInPath(workspace), 'https://planner.invalid');
  assert.equal(redirect.pathname, '/sign-in');
  assert.equal(redirect.searchParams.get('returnTo'), workspace);
});

test('workspace sign-in destinations discard off-site and non-workspace routes', () => {
  for (const target of [
    '//example.invalid/workspace', 'https://planner.invalid/workspace', '/\\example.invalid/workspace',
    '/%2f%2fexample.invalid/workspace', '/workspace\nTransfer', '/sign-in?next=/workspace',
    '/api/v1/projects', '/settings', '/projects/not-an-id', `/boards/${boardId}/cards/${cardId}/extra`,
  ]) {
    assert.equal(workspaceReturnPath(target), null, target);
    assert.equal(workspaceSignInPath(target), '/sign-in');
  }
});

test('board sign-in round trips each maximum repeated filter group and rejects oversized and off-site values', () => {
  const params = new URLSearchParams({ q: '界'.repeat(256), limit: '100', unassigned: 'true', context: 'archive', view: 'list',
    cursor: 'v1.' + 'A'.repeat(2045), ignore: 'unknown' });
  for (const [group, key] of boardFilterKeys.entries()) for (let index = 0; index < 50; index++) {
    params.append(key, '65160d3b-4e42-4023-880e-' + (group * 50 + index + 1).toString(16).padStart(12, '0'));
  }
  const route = '/boards/' + boardId + '/cards/' + cardId;
  const signIn = new URL(workspaceSignInPath(route + '?' + params), 'https://planner.invalid');
  const returned = workspaceReturnPath(signIn.searchParams.get('returnTo'));
  assert.ok(returned && returned.length > 13_000);
  const search = new URL(returned, 'https://planner.invalid').searchParams;
  for (const key of boardFilterKeys) assert.deepEqual(search.getAll(key), params.getAll(key));
  for (const key of ['q', 'limit', 'unassigned', 'context', 'view', 'cursor']) assert.equal(search.get(key), params.get(key));
  assert.equal(search.has('ignore'), false);
  assert.equal(workspaceSignInPath(route + '?q=' + 'x'.repeat(15_000)), '/sign-in');
  assert.equal(workspaceSignInPath('https://other.invalid' + route + '?' + params), '/sign-in');
  assert.equal(workspaceReturnPath(route + '?q=first&q=duplicate&labelsAny=' + boardId + '&labelsAny=foreign'), route);
});
