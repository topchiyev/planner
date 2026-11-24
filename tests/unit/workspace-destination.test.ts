import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceReturnPath, workspaceSignInPath } from '@planner/contracts';

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
