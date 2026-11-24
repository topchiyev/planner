import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { boardEventFrameSchema, mediaOperations } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { createMediaDecoder } from '../../apps/backend/dist/application/media/decoder.js';
import { createMediaService } from '../../apps/backend/dist/application/media/service.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';
import { workspaceFixtureInstant } from '../fixtures/planner-workspace.ts';
import { proxyHeaders } from '../support/account-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const card = (id = ids.activeCard) => '/api/v1/cards/' + id;
const board = (id) => '/api/v1/boards/' + id;
const list = (id) => '/api/v1/lists/' + id;
const sourceCard = ids.activeCard;
const workspaceRows = (f, name, extra = {}) => f.db.collection(name).find({ ...f.scope, ...extra }).sort({ id: 1 }).toArray();
const stored = (f, name, id) => f.db.collection(name).findOne({ ...f.scope, id }, { promoteLongs: false });

async function workspace(run, media = false) {
  await withFixtureMongo(async (mongo) => {
    let store;
    const f = await makeWorkspaceAccessFixture(mongo, media ? { async configureMedia({ db, directory, installationId, gate, now }) {
      const staging = join(directory, 'staging');
      const blobs = join(directory, 'blobs');
      await mkdir(staging, { mode: 0o700 });
      await mkdir(blobs, { mode: 0o700 });
      store = await createPrivateMediaStore(staging, blobs);
      const decode = createMediaDecoder(fileURLToPath(new URL('../../ops/package/decode-media.py', import.meta.url)), process.env.PLANNER_TEST_MEDIA_PYTHON);
      const service = createMediaService(db, installationId, gate, store, decode, { now });
      return (callback) => callback(service);
    } } : undefined);
    try { await run(f); } finally { await f.close(); await store?.close(); }
  });
}

async function signIn(f, actor) {
  const loggedIn = await f.login(actor);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

const headers = (actor, revision, key) => ({
  Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(actor)), 'If-Match': `"${revision}"`, 'Idempotency-Key': key,
});

function change(f, actor, method, route, revision, body, key = randomUUID()) {
  return f.call(route, actor, { method, body, headers: headers(actor, revision, key) });
}

async function expected(pending, status, code) {
  const response = await pending;
  assert.equal(response.status, status, JSON.stringify(response.data).slice(0, 1000));
  if (code) assert.equal(response.data.error.code, code);
  return response;
}
const data = async (pending, status = 200) => (await expected(pending, status)).data.data;
const destination = (toListId = ids.sharedClosedList, beforeCardId = null, sourceOrderVersion = 1, destinationOrderVersion = 1) =>
  ({ toListId, beforeCardId, sourceOrderVersion, destinationOrderVersion });

async function replayFrame(f, actor, boardId, cursor, kind) {
  const path = board(boardId) + '/events?after=' + encodeURIComponent(cursor);
  const response = await new Promise((resolve, reject) => {
    const req = request({ socketPath: f.socketPath, path, headers: { ...proxyHeaders(origin), Cookie: actor },
      signal: AbortSignal.timeout(15_000) }, resolve);
    req.once('error', reject).end();
  });
  assert.equal(response.statusCode, 200);
  let outstanding = '';
  try {
    for await (const chunk of response.setEncoding('utf8')) {
      outstanding += chunk;
      let boundary;
      while ((boundary = outstanding.indexOf('\n\n')) >= 0) {
        const lines = outstanding.slice(0, boundary).split('\n');
        outstanding = outstanding.slice(boundary + 2);
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        if (event === kind) return boardEventFrameSchema.parse({ event,
          data: JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6)) });
      }
    }
    assert.fail('The source board did not receive its removal event.');
  } finally { response.destroy(); }
}

test('cross-board card move remaps exact affiliations and fields while source-only callers receive only removal', { timeout: 140_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const sourceEditor = await signIn(f, ids.secondEditor);
    const reader = await signIn(f, ids.viewer);
    const updateKey = randomUUID();
    const updateBody = { description: 'Preserve this content after transfer.' };
    let current = (await data(change(f, editor, 'PATCH', card(), 1, updateBody, updateKey))).card;
    const checklistKey = randomUUID();
    const checkPath = '/api/v1/checklists/' + ids.checklist;
    const checkBody = { showOnFront: true };
    const checklistEdit = await data(change(f, editor, 'PATCH', checkPath, 1, checkBody, checklistKey));
    await f.gate.runCommand(() => f.db.collection('commands').updateOne({ ...f.scope, idempotencyKey: checklistKey },
      { $unset: { replayScope: '', replayScopeHash: '' } }));
    assert.deepEqual(await data(change(f, editor, 'PATCH', checkPath, 1, checkBody, checklistKey)), checklistEdit);
    current = await data(f.call(card(), editor));
    assert.equal(current.revision, checklistEdit.cardRevision);

    const named = await f.insert('labels', fixtureId(19000), { boardId: ids.privateBoard, name: ' Ｓtatus ', color: 'berry-red', rank: '1' });
    const copied = await f.insert('labels', fixtureId(19001), { boardId: ids.privateBoard, name: null, color: 'moss-green', rank: '2' });
    const match = await f.insert('labels', fixtureId(19002), { boardId: ids.sharedBoard, name: 'status', color: 'lagoon-blue', rank: '1' });
    await f.insert('labels', fixtureId(19003), { boardId: ids.sharedBoard, name: 'Status', color: 'turquoise-sea', rank: '2' });
    const keptLabelEdge = await f.insert('cardLabels', fixtureId(19004), { cardId: sourceCard, labelId: named });
    await f.insert('cardLabels', fixtureId(19005), { cardId: sourceCard, labelId: copied });
    const keptAssignee = await f.insert('cardAssignees', fixtureId(19006), { cardId: sourceCard, userId: ids.firstEditor });
    const keptFollow = await f.insert('cardFollows', fixtureId(19007), { cardId: sourceCard, userId: ids.firstEditor, isPermanent: false });
    await f.insert('cardFollows', fixtureId(19008), { cardId: sourceCard, userId: ids.secondEditor, isPermanent: true });
    await f.db.collection('tasks').updateOne({ ...f.scope, id: ids.linkedTask }, { $set: { assigneeId: ids.secondEditor } });
    const comment = await f.insert('comments', fixtureId(19009), { boardId: ids.privateBoard, cardId: sourceCard,
      authorId: ids.secondEditor, text: 'Keep protected comment attribution.' });
    await f.insert('activities', fixtureId(19010), { boardId: ids.privateBoard, cardId: sourceCard, actorId: ids.secondEditor, kind: 'oldActivity' });
    await f.insert('boardPreferences', fixtureId(19011), { boardId: ids.sharedBoard, restrictedCardType: 'story' });

    const template = await f.insert('fieldGroups', fixtureId(19012), { scopeType: 'project', scopeId: ids.privateProject, name: 'Release window', rank: '1' });
    const definition = await f.insert('fieldDefinitions', fixtureId(19013), { fieldGroupId: template, name: 'Release variant', rank: '1', showOnFront: true });
    const group = await f.insert('fieldGroups', fixtureId(19014), { scopeType: 'card', scopeId: sourceCard, templateGroupId: template, name: null, rank: '1' });
    const value = await f.insert('fieldValues', fixtureId(19015), {
      cardId: sourceCard, fieldGroupId: group, fieldDefinitionId: definition, value: '  blue / λ  ',
    });
    const referencing = await f.insert('cards', fixtureId(19016), { boardId: ids.privateBoard, listId: ids.privateActiveList,
      name: 'Source-only task owner', kind: 'board', type: 'project', rank: '2048' });
    const referencingGroup = await f.insert('checklists', fixtureId(19017), { cardId: referencing, name: 'Source links', rank: '1', showOnFront: true });
    const referencingTask = await f.insert('tasks', fixtureId(19018), {
      checklistId: referencingGroup, linkedCardId: sourceCard, completed: false, rank: '1',
    });
    const malformedTask = await f.insert('tasks', fixtureId(19019), {
      checklistId: referencingGroup, linkedCardId: sourceCard, linkedUnavailable: 'legacy', completed: false, rank: '2',
    });
    const corruptList = await f.insert('lists', fixtureId(19020), { boardId: ids.hiddenBoard, name: 'Unknown placement', kind: 'mystery', rank: '1' });
    const corruptCard = await f.insert('cards', fixtureId(19021), { boardId: ids.hiddenBoard, listId: corruptList,
      name: 'Unknown context', kind: 'mystery', type: 'project', rank: '1' });
    const corruptGroup = await f.insert('checklists', fixtureId(19022), { cardId: corruptCard, name: 'Private unknown fields', rank: '1' });
    const corruptTask = await f.insert('tasks', fixtureId(19023), { checklistId: corruptGroup, linkedCardId: sourceCard, completed: false, rank: '1' });
    const otherScope = await data(f.call(board(ids.privateBoard) + '/transfer-destinations', editor));
    assert.deepEqual(otherScope.map(({ id }) => id), [ids.sharedBoard]);
    assert.deepEqual(await data(f.call(board(ids.privateBoard) + '/transfer-destinations', sourceEditor)), []);
    await expected(f.call(board(ids.privateBoard) + '/transfer-destinations', reader), 403);

    const payload = Buffer.from('Keep this exact reference while moving.');
    const attachment = (await expected(upload(f, editor, current.revision, 'transfer.dat', payload), 201)).data.data.reference;
    const sourceCursor = (await data(f.call(board(ids.privateBoard) + '/workspace', reader))).eventCursor;
    current = await data(f.call(card(), editor));
    const route = card() + '/move';
    const denied = await expected(change(f, sourceEditor, 'POST', route, current.revision, destination()), 409, 'CARD_ORDER_CONFLICT');
    assert.equal(denied.data.error.fields, undefined);
    await expected(change(f, editor, 'POST', route, current.revision, destination(ids.sharedClosedList, referencing)), 409, 'CARD_ORDER_CONFLICT');
    const key = randomUUID();
    const moved = await data(change(f, editor, 'POST', route, current.revision, destination(), key));
    assert.deepEqual(moved.card, { id: sourceCard, boardId: ids.sharedBoard, listId: ids.sharedClosedList, kind: 'board', closed: true,
      revision: current.revision + 1 });
    assert.deepEqual(moved.remaps, { labelsRemapped: 2, labelsCreated: 1, removedAssignees: 1, removedFollows: 1,
      clearedTaskAssignees: 1, fieldGroupsMaterialized: 1 });
    assert.deepEqual(await data(change(f, editor, 'POST', route, current.revision, destination(), key)), moved);
    const next = await data(f.call(card(), editor));
    assert.equal(next.type, 'project');
    assert.deepEqual(next.assignees.map(({ id }) => id), [ids.firstEditor]);
    assert.equal((await stored(f, 'cardAssignees', keptAssignee)).userId, ids.firstEditor);
    assert.equal((await stored(f, 'cardFollows', keptFollow)).isPermanent, false);
    assert.equal((await stored(f, 'cardLabels', keptLabelEdge)).labelId, match);
    assert.deepEqual(next.values.map(({ value }) => value).sort(), ['  blue / λ  ', '  exact synthetic text  '].sort());
    assert.equal(next.fields.find(({ id }) => id === group).linked, false);
    const remapped = await stored(f, 'fieldValues', value);
    assert.equal(remapped.fieldGroupId, group);
    assert.notEqual(remapped.fieldDefinitionId, definition);
    assert.equal(remapped.createdAt.toISOString(), workspaceFixtureInstant);
    assert.equal((await stored(f, 'fieldGroups', ids.fieldGroup)).scopeId, ids.privateBoard);
    assert.equal((await stored(f, 'tasks', ids.linkedTask)).assigneeId, null);
    assert.equal((await stored(f, 'tasks', referencingTask)).completed, true);
    assert.deepEqual([(await stored(f, 'tasks', malformedTask)).revision,
      (await stored(f, 'tasks', corruptTask)).revision, (await stored(f, 'cards', corruptCard)).revision], [1, 1, 1]);
    assert.deepEqual([(await stored(f, 'comments', comment)).boardId, (await stored(f, 'comments', comment)).authorId], [ids.sharedBoard, ids.secondEditor]);
    assert.equal((await stored(f, 'activities', fixtureId(19010))).boardId, ids.privateBoard);
    const sourceToken = readSessionCookie(sourceEditor);
    const sourceAccess = await resolveBrowserWorkspace(f.db, f.installationId, sourceToken, f.now());
    await assert.rejects(sourceAccess.requireComment(comment), { statusCode: 404 });
    await expected(f.call(card(), reader), 404);
    assert.deepEqual(next.attachments.map(({ id }) => id), [attachment.id]);
    assert.equal((await bytesRequest(f, sourceEditor, download(attachment.id), 'HEAD')).status, 404);
    assert.deepEqual((await bytesRequest(f, editor, download(attachment.id))).bytes, payload);
    assert.deepEqual(await replayFrame(f, reader, ids.privateBoard, sourceCursor, 'card.removed'),
      { event: 'card.removed', data: { boardId: ids.privateBoard, id: sourceCard } });
    const sourceDetails = await data(f.call(card(referencing) + '/checklists', reader));
    const neutral = sourceDetails[0].tasks[0];
    assert.equal(neutral.kind, 'unavailable');
    assert.ok(!JSON.stringify(neutral).includes(ids.sharedBoard));
    assert.ok(!JSON.stringify(neutral).includes(sourceCard));
    const command = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    const sourceEvents = await workspaceRows(f, 'events', { commandId: command.id, boardId: ids.privateBoard });
    assert.deepEqual(sourceEvents.find(({ kind }) => kind === 'card.removed').payload, { id: sourceCard });
    assert.ok(!JSON.stringify(sourceEvents).includes(ids.sharedBoard));
    assert.equal(await f.db.collection('events').countDocuments({ ...f.scope, commandId: command.id, boardId: ids.hiddenBoard }), 0);
    assert.equal(await f.db.collection('notifications').countDocuments({ ...f.scope, cardId: sourceCard }), 0);

    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.firstEditor }));
    await expected(change(f, editor, 'POST', route, current.revision, destination(), key), 404);
    await expected(change(f, editor, 'PATCH', card(), 1, updateBody, updateKey), 404);
    await expected(change(f, editor, 'PATCH', checkPath, 1, checkBody, checklistKey), 404);
    // Previous shipped builds stored the old public board in the result and had no private replay scope.
    await f.gate.runCommand(() => f.db.collection('commands').updateOne({ ...f.scope, idempotencyKey: updateKey },
      { $unset: { replayScope: '', replayScopeHash: '' } }));
    await expected(change(f, editor, 'PATCH', card(), 1, updateBody, updateKey), 404);
    assert.equal((await data(f.call(card(), editor))).boardId, ids.sharedBoard);
  }, true);
});

function bytesRequest(f, actor, path, method = 'GET', extra = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: f.socketPath, path, method, headers: { ...proxyHeaders(origin), Cookie: actor, ...extra } },
      async (reply) => {
        try {
          const samples = [];
          for await (const sample of reply) samples.push(sample);
          const bytes = Buffer.concat(samples);
          const data = bytes.length && reply.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString()) : null;
          resolve({ status: reply.statusCode, data, bytes });
        } catch (error) { reject(error); }
      });
    req.once('error', reject).end(body);
  });
}

function upload(f, actor, revision, name, bytes) {
  const marker = 'FixtureTransferBoundary';
  const head = Buffer.from(`--${marker}\r\nContent-Disposition: form-data; name="byteLength"\r\n\r\n${bytes.length}\r\n--${marker}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const body = Buffer.concat([head, bytes, Buffer.from(`\r\n--${marker}--\r\n`)]);
  return bytesRequest(f, actor, card() + '/attachment-files', 'POST', {
    ...headers(actor, revision, randomUUID()), 'Content-Type': 'multipart/form-data; boundary=' + marker, 'Content-Length': body.length,
  }, body);
}
const download = (id) => mediaOperations.attachmentDownload.path.replace(':id', id);

test('a source manager can duplicate to an edited board with independent reference identities and retained exact content', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const manager = await signIn(f, ids.privateOwner);
    const sourceEditor = await signIn(f, ids.secondEditor);
    const viewer = await signIn(f, ids.viewer);
    await f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.privateOwner });
    await f.insert('boardMembers', fixtureId(20100), { boardId: ids.sharedBoard, userId: ids.privateOwner, role: 'editor', canComment: null });
    await f.insert('boardMembers', fixtureId(20101), { boardId: ids.sharedBoard, userId: ids.secondEditor, role: 'viewer', canComment: false });
    await f.db.collection('users').updateOne({ ...f.scope, id: ids.privateOwner }, { $set: { 'preferences.followOwnCards': true } });
    await f.insert('boardPreferences', fixtureId(20102), { boardId: ids.sharedBoard, restrictedCardType: 'story' });
    await f.insert('cardFollows', fixtureId(20103), { cardId: sourceCard, userId: ids.viewer, isPermanent: true });
    const label = await f.insert('labels', fixtureId(20104), { boardId: ids.privateBoard, name: 'Release', color: 'lagoon-blue', rank: '1' });
    await f.insert('cardLabels', fixtureId(20105), { cardId: sourceCard, labelId: label });
    const sourceProject = await f.insert('projects', fixtureId(20106), { name: 'Hidden link project',
      type: 'private', hidden: false, ownerProjectManagerId: null, rank: '50000' });
    const privateOtherBoard = await f.insert('boards', fixtureId(20107), { name: 'Hidden link board', projectId: sourceProject, rank: '1' });
    const hiddenList = await f.insert('lists', fixtureId(20108), { name: 'Hidden link lane', boardId: privateOtherBoard, kind: 'active', rank: '1' });
    const hiddenCard = await f.insert('cards', fixtureId(20109), { name: 'Do not copy this title', boardId: privateOtherBoard,
      listId: hiddenList, kind: 'board', type: 'project', rank: '1' });
    const sourceOnlyTask = await f.insert('tasks', fixtureId(20110), { checklistId: ids.checklist, linkedCardId: hiddenCard, completed: true, rank: '2048' });
    await f.insert('comments', fixtureId(20111), { cardId: sourceCard, boardId: ids.privateBoard, text: 'Original comment', authorId: ids.firstEditor });

    const imageAvailable = !!process.env.PLANNER_TEST_MEDIA_PYTHON
      || spawnSync('/usr/bin/python3', ['-I', '-B', '-c', 'import PIL']).status === 0;
    const bytes = imageAvailable ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
      : Buffer.from('Independent reference bytes');
    const original = (await expected(upload(f, editor, 1, imageAvailable ? 'transfer.png' : 'transfer.dat', bytes), 201)).data.data.reference;
    const { revision, permissions } = await data(f.call(card(), manager));
    assert.deepEqual([permissions.canMove, permissions.canDuplicateFrom], [false, true]);
    await expected(change(f, manager, 'POST', card() + '/move', revision, destination()), 403);
    await expected(change(f, viewer, 'POST', card() + '/duplicate', revision, destination()), 403);
    await expected(change(f, manager, 'POST', card() + '/duplicate', revision, destination()), 422, 'CARD_TYPE_RESTRICTED');
    await f.db.collection('boardPreferences').updateOne({ ...f.scope, boardId: ids.sharedBoard }, { $set: { restrictedCardType: null } });

    const key = randomUUID();
    const duplicated = await data(change(f, manager, 'POST', card() + '/duplicate', revision, destination(), key), 201);
    assert.deepEqual(await data(change(f, manager, 'POST', card() + '/duplicate', revision, destination(), key), 201), duplicated);
    const id = duplicated.card.id;
    assert.notEqual(id, sourceCard);
    assert.deepEqual([duplicated.card.boardId, duplicated.card.listId, duplicated.card.revision, duplicated.card.closed],
      [ids.sharedBoard, ids.sharedClosedList, 1, true]);
    assert.equal((await stored(f, 'cards', id)).creatorId, ids.privateOwner);
    assert.equal((await stored(f, 'cards', sourceCard)).revision, revision);
    const detail = await data(f.call(card(id), manager));
    const clone = detail.attachments[0];
    assert.notEqual(clone.id, original.id);
    assert.equal(detail.coverAttachmentId, imageAvailable ? clone.id : null);
    assert.equal((await stored(f, 'attachments', clone.id)).blobDigest, (await stored(f, 'attachments', original.id)).blobDigest);
    assert.equal(detail.values[0].value, '  exact synthetic text  ');
    assert.notEqual(detail.values[0].fieldGroupId, ids.fieldGroup);
    assert.notEqual(detail.values[0].fieldDefinitionId, ids.fieldDefinition);
    assert.deepEqual(detail.assignees.map(({ id }) => id), [ids.secondEditor]);
    const follows = await workspaceRows(f, 'cardFollows', { cardId: id });
    assert.deepEqual(new Map(follows.map(({ userId, isPermanent }) => [userId, isPermanent])),
      new Map([[ids.secondEditor, false], [ids.privateOwner, true]]));
    const lists = await data(f.call(card(id) + '/checklists', manager));
    assert.notEqual(lists[0].id, ids.checklist);
    assert.notEqual(lists[0].tasks[0].id, ids.linkedTask);
    assert.notEqual(lists[0].tasks[1].id, sourceOnlyTask);
    assert.equal(lists[0].tasks[0].linkedCard.id, ids.sharedTarget);
    assert.equal(lists[0].tasks[1].kind, 'unavailable');
    const copiedTask = await stored(f, 'tasks', lists[0].tasks[1].id);
    assert.equal(copiedTask.linkedCardId, null);
    assert.ok(!JSON.stringify(copiedTask).includes(hiddenCard));
    assert.equal(await f.db.collection('comments').countDocuments({ ...f.scope, cardId: id }), 0);
    assert.deepEqual((await workspaceRows(f, 'activities', { cardId: id })).map(({ kind }) => kind), ['duplicateCard']);
    assert.equal(await f.db.collection('notifications').countDocuments({ ...f.scope, cardId: id }), 0);
    assert.equal((await bytesRequest(f, viewer, download(clone.id), 'HEAD')).status, 404);
    assert.deepEqual((await bytesRequest(f, manager, download(clone.id))).bytes, bytes);
    await expected(change(f, manager, 'DELETE', mediaOperations.removeAttachment.path.replace(':id', clone.id), clone.revision), 204);
    assert.equal((await bytesRequest(f, manager, download(clone.id), 'HEAD')).status, 404);
    assert.deepEqual((await bytesRequest(f, sourceEditor, download(original.id))).bytes, bytes);
  }, true);
});

test('one populated finite-list transfer recovers across journal batches without changing occupancy order', { timeout: 160_000 }, async () => {
  await workspace(async (f) => {
    const actor = await signIn(f, ids.firstEditor);
    const reader = await signIn(f, ids.viewer);
    const listId = await f.insert('lists', fixtureId(22000), { name: 'Move the whole lane', boardId: ids.privateBoard,
      kind: 'closed', rank: '9007199254740995', orderVersion: 5 });
    const route = list(listId) + '/move';
    const oldKey = randomUUID();
    const rename = { name: 'Reviewed lane' };
    await data(change(f, actor, 'PATCH', list(listId), 1, rename, oldKey));
    for (let index = 0; index < 130; index++) {
      const id = fixtureId(23000 + index);
      await f.insert('cards', id, { name: 'Card in scope ' + index, type: 'project', kind: 'board', boardId: ids.privateBoard,
        listId, rank: (9007199254740995n + BigInt(index)).toString(), closed: true });
      await f.insert('comments', fixtureId(24000 + index), { text: 'Preserved comment ' + index, cardId: id,
        boardId: ids.privateBoard, authorId: ids.secondEditor });
    }
    const body = { toBoardId: ids.sharedBoard, beforeListId: ids.sharedClosedList, sourceOrderVersion: 1, destinationOrderVersion: 1 };
    const key = randomUUID();
    const token = readSessionCookie(actor);
    const journal = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () =>
        resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), 'web', key),
      checkpoint(point, index) {
        if (point === 'effectApplied' && index === 256) throw new Error('test interruption between transfer batches');
      },
    });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId: 'lists.move', idempotencyKey: key,
      input: { id: listId, expectedRevision: 2, ...body } }), /test interruption/u);
    assert.equal(f.gate.ready, false);
    await expected(f.call(card(fixtureId(23000)), actor), 503);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const result = await data(change(f, actor, 'POST', route, 2, body, key));
    assert.deepEqual([result.list.id, result.list.boardId, result.list.orderVersion, result.sourceBoardOrderVersion, result.boardOrderVersion],
      [listId, ids.sharedBoard, 5, 2, 2]);
    assert.equal(await f.db.collection('cards').countDocuments({ ...f.scope, boardId: ids.sharedBoard, listId, closed: true }), 130);
    assert.equal(await f.db.collection('comments').countDocuments({ ...f.scope, boardId: ids.sharedBoard }), 130);
    const first = await stored(f, 'cards', fixtureId(23000));
    assert.equal(first.rank.toBigInt(), 9007199254740995n);
    assert.equal(first.type, 'project');
    assert.equal(first.revision, 2);
    assert.equal(await f.db.collection('activities').countDocuments({ ...f.scope, listId, kind: 'moveList' }), 1);
    const proof = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    assert.ok(proof.manifest.length >= 2);
    assert.equal(await f.db.collection('events').countDocuments({ ...f.scope, commandId: proof.id, boardId: ids.privateBoard, kind: 'card.removed' }), 130);
    assert.equal(await f.db.collection('notifications').countDocuments(f.scope), 0);
    assert.equal((await stored(f, 'lists', ids.privateArchive)).rank, null);
    await expected(f.call(card(fixtureId(23000)), reader), 404);
    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.firstEditor }));
    await expected(change(f, actor, 'POST', route, 2, body, key), 404);
    await expected(change(f, actor, 'PATCH', list(listId), 1, rename, oldKey), 404);
  });
});

test('historical transfer reserves the destination sequence and preserves an exact compatible template', { timeout: 100_000 }, async () => {
  await workspace(async (f) => {
    const actor = await signIn(f, ids.firstEditor);
    const sameProject = await f.insert('boards', fixtureId(27000), { name: 'Same project board', projectId: ids.privateProject, rank: '2048' });
    await f.insert('boardMembers', fixtureId(27001), { boardId: sameProject, userId: ids.firstEditor, role: 'editor', canComment: null });
    const archive = await f.insert('lists', fixtureId(27002), { name: 'Archive', boardId: sameProject, kind: 'archive', rank: null });
    const finite = await f.insert('lists', fixtureId(27003), { name: 'Ready to restore', boardId: sameProject, kind: 'active', rank: '1024' });
    await f.insert('cards', fixtureId(27004), { name: 'Historical high water', boardId: sameProject, listId: archive, kind: 'archive',
      type: 'story', rank: null, historySequence: '9007199254740995', listChangedAt: workspaceFixtureInstant, closed: true });
    const template = await f.insert('fieldGroups', fixtureId(27005), { name: 'Shared project field', scopeType: 'project', scopeId: ids.privateProject, rank: '1' });
    const source = await f.insert('fieldGroups', fixtureId(27006), {
      name: null, scopeType: 'board', scopeId: ids.privateBoard, templateGroupId: template, rank: '2048',
    });
    const definition = await f.insert('fieldDefinitions', fixtureId(27007), { name: 'Exact blank value', fieldGroupId: template, rank: '1', showOnFront: true });
    const id = await f.insert('fieldValues', fixtureId(27008), {
      cardId: sourceCard, fieldGroupId: source, fieldDefinitionId: definition, value: '',
    });
    const local = await f.insert('fieldDefinitions', fixtureId(27009), { name: 'Local earlier field', fieldGroupId: source, rank: '-1' });
    await f.insert('fieldValues', fixtureId(27010), { cardId: sourceCard, fieldGroupId: source, fieldDefinitionId: local, value: '00' });
    const tiedGroup = await f.insert('fieldGroups', fixtureId(27011), {
      name: 'Tied field order', scopeType: 'board', scopeId: ids.privateBoard, templateGroupId: template, rank: '3072',
    });
    const tiedDefinition = await f.insert('fieldDefinitions', fixtureId(27012), { name: 'Tied local field', fieldGroupId: tiedGroup, rank: '1' });
    const tiedValue = await f.insert('fieldValues', fixtureId(27013), {
      cardId: sourceCard, fieldGroupId: tiedGroup, fieldDefinitionId: tiedDefinition, value: '  tied  ',
    });
    const key = randomUUID();
    await expected(change(f, actor, 'POST', card() + '/move', 1, destination(archive, ids.activeCard)), 422, 'INVALID_CARD_TRANSITION');
    const moved = await data(change(f, actor, 'POST', card() + '/move', 1, destination(archive), key));
    assert.deepEqual(await data(change(f, actor, 'POST', card() + '/move', 1, destination(archive), key)), moved);
    const persisted = await stored(f, 'cards', sourceCard);
    assert.deepEqual([persisted.boardId, persisted.kind, persisted.rank, persisted.historySequence.toBigInt(), persisted.previousListId],
      [sameProject, 'archive', null, 9007199254740996n, null]);
    const value = await stored(f, 'fieldValues', id);
    assert.equal(value.fieldDefinitionId, definition);
    assert.equal(value.value, '');
    const instance = await stored(f, 'fieldGroups', value.fieldGroupId);
    assert.deepEqual([instance.scopeType, instance.scopeId, instance.templateGroupId], ['card', sourceCard, template]);
    assert.notEqual(instance.id, source);
    const detail = await data(f.call(card(), actor));
    assert.deepEqual(detail.fields.find(({ id }) => id === instance.id).definitions.map(({ name, rank, inherited }) =>
      [name, rank, inherited]), [['Local earlier field', '-1', false], ['Exact blank value', '1', true]]);
    const tied = await stored(f, 'fieldValues', tiedValue);
    const detached = detail.fields.find(({ id }) => id === tied.fieldGroupId);
    assert.deepEqual([detached.linked, detached.definitions.map(({ name }) => name), tied.value],
      [false, ['Exact blank value', 'Tied local field'], '  tied  ']);
    await expected(change(f, actor, 'POST', card() + '/restore', moved.card.revision, { sourceOrderVersion: 2 }), 422, 'RESTORE_TARGET_REQUIRED');
    const restored = await data(change(f, actor, 'POST', card() + '/restore', moved.card.revision, destination(finite, null, 2, 1)));
    assert.equal(restored.card.listId, finite);
    assert.equal(restored.card.closed, false);
  });
});

test('creation and promotion receipts require current access to the result as well as the original scope', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const actor = await signIn(f, ids.firstEditor);
    const manager = await signIn(f, ids.privateOwner);
    const made = { name: 'Created before transfer' };
    const madeKey = randomUUID();
    const createPath = list(ids.privateActiveList) + '/cards';
    const created = await data(change(f, actor, 'POST', createPath, 1, made, madeKey), 201);
    const originalPlacement = destination(ids.privateClosedList, null, 2, 1);
    const copyKey = randomUUID();
    const copied = await data(change(f, actor, 'POST', card() + '/duplicate', 1, originalPlacement, copyKey), 201);
    const listKey = randomUUID();
    const listPath = board(ids.privateBoard) + '/lists';
    const listBody = { name: 'Created lane before transfer', kind: 'active' };
    const newList = await data(change(f, actor, 'POST', listPath, 1, listBody, listKey), 201);
    await data(change(f, actor, 'POST', card(created.card.id) + '/move', 1, destination(ids.sharedActiveList, null, 2, 1)));
    await data(change(f, actor, 'POST', card(copied.card.id) + '/move', 1, destination(ids.sharedActiveList, null, 2, 2)));
    await data(change(f, actor, 'POST', list(newList.list.id) + '/move', 1, {
      toBoardId: ids.sharedBoard, beforeListId: null, sourceOrderVersion: 2, destinationOrderVersion: 1,
    }));
    assert.deepEqual(await data(change(f, actor, 'POST', createPath, 1, made, madeKey), 201), created);
    assert.deepEqual(await data(change(f, actor, 'POST', card() + '/duplicate', 1, originalPlacement, copyKey), 201), copied);
    assert.deepEqual(await data(change(f, actor, 'POST', listPath, 1, listBody, listKey), 201), newList);

    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: ids.sharedBoard, userId: ids.firstEditor }));
    await expected(change(f, actor, 'POST', createPath, 1, made, madeKey), 404);
    await expected(change(f, actor, 'POST', card() + '/duplicate', 1, originalPlacement, copyKey), 404);
    await expected(change(f, actor, 'POST', listPath, 1, listBody, listKey), 404);
    await expected(f.call(card(created.card.id), actor), 404);

    const group = await f.insert('fieldGroups', fixtureId(27100), { name: 'Promotion remains tied to its project',
      scopeType: 'card', scopeId: sourceCard, rank: '1' });
    await f.insert('projectManagers', fixtureId(27101), { projectId: ids.sharedProject, userId: ids.privateOwner });
    await f.insert('boardMembers', fixtureId(27102), { boardId: ids.sharedBoard, userId: ids.privateOwner, role: 'editor', canComment: null });
    const promoteKey = randomUUID();
    const promotePath = '/api/v1/field-groups/' + group + '/promote';
    const promote = { projectRevision: 1 };
    const template = await data(change(f, manager, 'POST', promotePath, 1, promote, promoteKey), 201);
    await data(change(f, manager, 'POST', card() + '/move', 1, destination(ids.sharedClosedList, null, 3, 1)));
    assert.deepEqual(await data(change(f, manager, 'POST', promotePath, 1, promote, promoteKey), 201), template);
    await f.gate.runCommand(() => f.db.collection('projectManagers').deleteOne({ ...f.scope, projectId: ids.privateProject, userId: ids.privateOwner }));
    await expected(change(f, manager, 'POST', promotePath, 1, promote, promoteKey), 404);
    assert.ok((await data(f.call(card(), manager))).fields.some(({ id }) => id === group));
  });
});
