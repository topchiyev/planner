import assert from 'node:assert/strict';
import test from 'node:test';
import { Long } from 'mongodb';
import { boardFilterKeys, workspaceReturnPath } from '@planner/contracts';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const boardCards = (id = ids.privateBoard) => '/api/v1/boards/' + id + '/cards';
const listTime = '2026-01-15T10:30:45.000Z';
const cardSeed = (fields) => ({ boardId: ids.privateBoard, listId: ids.privateActiveList, type: 'project', kind: 'board', ...fields });
const selectedIds = ({ data }) => data.map(({ id }) => id);
const countMap = ({ counts }) => new Map(counts.map(({ listId, count }) => [listId, count]));

async function website(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, id) {
  const response = await f.login(id);
  assert.equal(response.status, 200);
  return cookieOf(response);
}

async function query(f, actor, fields = {}, id) {
  const params = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
  return f.call(boardCards(id) + (params.size ? '?' + params : ''), actor);
}
async function result(response) {
  const actual = await response;
  assert.equal(actual.status, 200, JSON.stringify(actual.data).slice(0, 1000));
  return actual.data;
}

test('authorized normalized queries count all matches before a stable signed-rank or history cursor', { timeout: 125_000 }, async () => {
  await website(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const shared = await signIn(f, ids.projectManager);
    const make = async (index, fields) => f.insert('cards', fixtureId(28000 + index), cardSeed(fields));
    for (let index = 0; index < 26; index++) await make(index, {
      listId: index < 20 ? ids.privateActiveList : ids.privateClosedList, name: 'Cafe\u0301 dispatch ' + index,
      description: 'Bridge with Artifact/', rank: '9007199254740997',
    });
    const nowhere = await f.insert('lists', fixtureId(28100), { name: 'Malformed placement', boardId: ids.privateBoard, kind: 'active', rank: '2048' });
    await f.db.collection('lists').updateOne({ ...f.scope, id: nowhere }, { $set: { boardId: [ids.privateBoard] } });
    await make(30, { listId: nowhere, name: 'Café dispatch phantom one', description: 'Bridge', rank: '9007199254740997' });
    const drift = await make(31, { name: 'Café dispatch phantom two', description: 'Bridge', rank: '9007199254740997' });
    await f.db.collection('cards').updateOne({ ...f.scope, id: drift }, { $set: { kind: ['board'] } });
    await make(32, { listId: ids.sharedActiveList, name: 'Café dispatch phantom three', description: 'Bridge', rank: '9007199254740997' });
    await f.insert('cards', fixtureId(28033), cardSeed({
      name: 'Café dispatch staged', description: 'Bridge', rank: '9007199254740997',
    }), f.stagedGenerationId);
    const nullable = await make(34, { name: 'Artifact/ named on card', description: null, rank: '9223372036854775806' });
    const expectIds = Array.from({ length: 26 }, (_, index) => fixtureId(28000 + index));
    const input = { q: 'BRIDGE; café', limit: '25' };
    const first = await result(query(f, editor, input));
    assert.deepEqual(selectedIds(first), expectIds.slice(0, 25));
    assert.deepEqual(countMap(first), new Map([[ids.privateActiveList, 20], [ids.privateClosedList, 6]]));
    const cursor = first.page.nextCursor;
    assert.ok(cursor);
    const second = await result(query(f, editor, { ...input, q: 'café,BRIDGE,bridge', cursor }));
    assert.deepEqual(selectedIds(second), [expectIds[25]]);
    assert.deepEqual(countMap(second), countMap(first));
    assert.equal(second.page.nextCursor, null);
    assert.deepEqual(selectedIds(await result(query(f, editor, { q: 'Artifact/', limit: '100' }))), [...expectIds, nullable]);
    assert.deepEqual((await query(f, shared, { q: 'x'.repeat(257), members: 'bad' })).status, 404);
    assert.equal((await query(f, viewer, { q: 'x'.repeat(257), members: 'bad' })).status, 422);
    assert.equal((await query(f, viewer, { ...input, cursor })).status, 422);
    await f.gate.runCommand(() => f.db.collection('boardMembers').updateOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.firstEditor },
      { $set: { role: 'viewer', canComment: false } }));
    const stale = await query(f, editor, { ...input, cursor });
    assert.equal(stale.data.error.code, 'INVALID_CURSOR');
    assert.deepEqual(selectedIds(await result(query(f, editor, input))), expectIds.slice(0, 25));
    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.firstEditor }));
    assert.equal((await query(f, editor, { ...input, cursor })).status, 404);

    const historical = [];
    for (const [index, sequence] of [[35, '9007199254740999'], [36, '9007199254740999'], [37, '9007199254740998']]) {
      historical.push(await make(index, { name: 'Historical marker ' + index, kind: 'archive', listId: ids.privateArchive,
        rank: null, listChangedAt: listTime, historySequence: sequence }));
    }
    const next = { context: 'archive', q: 'marker', limit: '2' };
    const archive = await result(query(f, viewer, next));
    assert.deepEqual(selectedIds(archive), [historical[1], historical[0]]);
    const tail = await result(query(f, viewer, { ...next, cursor: archive.page.nextCursor }));
    assert.deepEqual(selectedIds(tail), [historical[2]]);
    assert.deepEqual(countMap(tail), new Map([[ids.privateArchive, 3]]));
  });
});

test('filter groups require exact current labels and eligible direct or visible task relationships', { timeout: 125_000 }, async () => {
  await website(async (f) => {
    const actor = await signIn(f, ids.viewer);
    const source = await f.insert('labels', fixtureId(28201), { boardId: ids.privateBoard, name: 'Owned label', rank: '1' });
    const exclude = await f.insert('labels', fixtureId(28202), { boardId: ids.privateBoard, name: 'Exclude me', rank: '2' });
    const foreign = await f.insert('labels', fixtureId(28203), { boardId: ids.sharedBoard, name: 'Foreign label', rank: '1' });
    const taskOnly = await f.insert('cards', fixtureId(28204), cardSeed({ name: 'Only task assignee', rank: '2048' }));
    const negative = await f.insert('cards', fixtureId(28205), cardSeed({ name: 'Negative card', rank: '3072' }));
    const hidden = await f.insert('cards', fixtureId(28206), cardSeed({ name: 'Hidden linked assignee', rank: '4096' }));
    for (const [index, cardId, labelId] of [[7, taskOnly, source], [8, negative, source], [9, negative, exclude], [10, hidden, foreign]]) {
      await f.insert('cardLabels', fixtureId(28200 + index), { cardId, labelId });
    }
    const staleScalar = await f.insert('cardLabels', fixtureId(28211), { cardId: hidden, labelId: source });
    await f.db.collection('cardLabels').updateOne({ ...f.scope, id: staleScalar }, { $set: { labelId: [source] } });
    const work = await f.insert('checklists', fixtureId(28212), { cardId: taskOnly, name: 'Owned task group', rank: '1' });
    const invisible = await f.insert('checklists', fixtureId(28213), { cardId: hidden, name: 'Restricted task link group', rank: '1' });
    await f.insert('tasks', fixtureId(28214), { checklistId: work, name: 'Direct task', rank: '1', assigneeId: ids.secondEditor });
    await f.insert('tasks', fixtureId(28215), { checklistId: invisible, linkedCardId: ids.sharedTarget, rank: '1', assigneeId: ids.secondEditor });
    await f.insert('tasks', fixtureId(28216), { checklistId: invisible, name: 'Hidden marker', linkedUnavailable: 'legacy', rank: '2', assigneeId: ids.secondEditor });
    await f.insert('cardAssignees', fixtureId(28217), { cardId: taskOnly, userId: ids.disabledMember });
    const invalidAssignment = await f.insert('cardAssignees', fixtureId(28218), { cardId: negative, userId: ids.firstEditor });
    await f.db.collection('cardAssignees').updateOne({ ...f.scope, id: invalidAssignment }, { $set: { userId: [ids.firstEditor] } });

    const req = new URLSearchParams({ members: ids.secondEditor, unassigned: 'true', labelsNone: exclude });
    for (const id of [source, foreign, source]) req.append('labelsAny', id);
    const matched = await result(query(f, actor, req));
    assert.deepEqual(selectedIds(matched), [taskOnly]);
    assert.deepEqual(countMap(matched), new Map([[ids.privateActiveList, 1]]));
    assert.deepEqual(selectedIds(await result(query(f, actor, { labelsAny: source, labelsNone: source }))), []);
    assert.deepEqual(selectedIds(await result(query(f, actor, { labelsAny: foreign }))), []);
    assert.deepEqual(selectedIds(await result(query(f, actor, { members: ids.secondEditor }))), [ids.activeCard, taskOnly]);
    assert.deepEqual(selectedIds(await result(query(f, actor, { members: ids.firstEditor }))), []);
    const roster = await f.call('/api/v1/boards/' + ids.privateBoard + '/filter-members', actor);
    assert.equal(roster.status, 200);
    assert.ok(roster.data.data.some(({ id }) => id === ids.secondEditor));
    assert.ok(!roster.data.data.some(({ id }) => id === ids.disabledMember));
    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.secondEditor }));
    assert.deepEqual(selectedIds(await result(query(f, actor, { members: ids.secondEditor }))), []);
  });
});

test('RE2 runs exact full-field matches and declines unsupported syntax or a bounded scan without partial counts', { timeout: 125_000 }, async () => {
  await website(async (f) => {
    const viewer = await signIn(f, ids.viewer);
    const long = await f.insert('cards', fixtureId(28400), cardSeed({
      name: 'Imported description', description: 'a'.repeat(1_000_000) + '\nTail Λ42', rank: '5000',
    }));
    assert.deepEqual(selectedIds(await result(query(f, viewer, { q: '/tail \\p{Greek}{1}42$/' }))), [long]);
    for (const q of ['/(?<=Tail )Λ/', '/(a)\\1/', '/([/']) {
      const bad = await result(query(f, viewer, { q }));
      assert.deepEqual(bad, { data: [], counts: [], page: { nextCursor: null }, searchValidation: 'invalid-pattern' });
    }
    for (let index = 0; index < 4; index++) await f.insert('cards', fixtureId(28401 + index), cardSeed({
      name: 'Large content ' + index, description: '9'.repeat(9 * 1024 * 1024), rank: '6000',
    }));
    const capped = await result(query(f, viewer, { q: '/9+/' }));
    assert.deepEqual(capped, { data: [], counts: [], page: { nextCursor: null }, searchValidation: 'search-limit' });
    assert.ok(Long.isLong((await f.db.collection('cards').findOne({ ...f.scope, id: long }, { promoteLongs: false })).rank));
  });
});

test('the protected Unix HTTP parser accepts a complete filter redirect with ordinary forwarded headers', { timeout: 125_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo, { browserOrigin: origin });
    try {
      const params = new URLSearchParams({ context: 'archive', view: 'list', cursor: 'v1.' + 'A'.repeat(2045), q: '界'.repeat(256) });
      for (const [group, key] of boardFilterKeys.entries()) for (let index = 0; index < 50; index++) {
        params.append(key, fixtureId(29000 + group * 50 + index));
      }
      params.set('unassigned', 'true');
      params.set('limit', '100');
      const path = '/boards/' + ids.privateBoard + '/cards/' + ids.activeCard + '?' + params;
      const headers = { 'User-Agent': 'Synthetic browser ' + 'x'.repeat(384) };
      const redirect = await f.call(path, null, { headers });
      assert.equal(redirect.status, 302);
      assert.ok(redirect.headers.location.length > 16_000);
      assert.equal(new URL(redirect.headers.location, origin).searchParams.get('returnTo'), path);
      const served = await f.call(redirect.headers.location, null, { headers });
      assert.equal(served.status, 200);
      assert.match(served.headers['content-type'], /^text\/html/u);
      const offsite = 'https://other.invalid' + path;
      assert.equal(workspaceReturnPath(offsite), null);
      const foreign = await f.call('/sign-in?' + new URLSearchParams({ returnTo: offsite }), null, { headers });
      assert.equal(foreign.status, 200);
      assert.equal(foreign.headers.location, undefined);
    } finally { await f.close(); }
  });
});
