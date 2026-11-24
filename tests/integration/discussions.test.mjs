import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { cardMentionToken, relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const card = (id) => '/api/v1/cards/' + id;
const board = (id) => '/api/v1/boards/' + id;
const comment = (id) => '/api/v1/comments/' + id;
const notice = (id) => '/api/v1/notifications/' + id;
const inbox = '/api/v1/notifications';

async function workspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, actor) {
  const loggedIn = await f.login(actor);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

function write(f, actor, method, path, revision, body, key = randomUUID()) {
  const headers = { Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(actor)), 'Idempotency-Key': key,
    ...(revision !== undefined && { 'If-Match': '"' + revision + '"' }) };
  return f.call(path, actor, { method, body, headers });
}

async function expectResponse(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data).slice(0, 1000));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result;
}

const data = async (pending, status = 200) => (await expectResponse(pending, status)).data.data;
const row = (f, name, id) => f.db.collection(name).findOne({ ...f.scope, id });
const comments = (id) => card(id) + '/comments';
const mention = (id, name = 'Fixture [Member] \\') => cardMentionToken({ id, name, username: null });

test('scoped comments journal follow preference and deduplicated eligible mentions, then refresh moderation', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const author = await signIn(f, ids.commentingViewer);
    const editor = await signIn(f, ids.firstEditor);
    const other = await signIn(f, ids.secondEditor);
    const viewer = await signIn(f, ids.viewer);
    const manager = await signIn(f, ids.privateOwner);
    await f.gate.runCommand(() => f.db.collection('boardMembers').deleteOne({
      ...f.scope, boardId: ids.privateBoard, userId: ids.privateOwner,
    }));
    const admin = await signIn(f, ids.admin);
    const id = ids.activeCard;
    await f.db.collection('users').updateOne({ ...f.scope, id: ids.commentingViewer }, { $set: { 'preferences.followOnComment': true } });
    const automatic = await f.insert('cardFollows', fixtureId(20100), { cardId: id, userId: ids.commentingViewer, isPermanent: false });
    await f.insert('boardFollows', fixtureId(20101), { boardId: ids.privateBoard, userId: ids.secondEditor });
    await f.insert('cardFollows', fixtureId(20102), { cardId: id, userId: ids.secondEditor, isPermanent: true });
    await f.insert('cardFollows', fixtureId(20103), { cardId: id, userId: ids.viewer, isPermanent: true });
    await f.insert('boardFollows', fixtureId(20104), { boardId: ids.privateBoard, userId: ids.disabledMember });
    await f.insert('boardFollows', fixtureId(20105), { boardId: ids.privateBoard, userId: ids.admin });
    const candidates = await data(f.call(board(ids.privateBoard) + '/mention-members?q=second-editor', author));
    assert.deepEqual(candidates, [{ id: ids.secondEditor, name: 'Fixture second-editor', username: null }]);
    await expectResponse(f.call(board(ids.privateBoard) + '/mention-members', viewer), 403);
    await expectResponse(write(f, viewer, 'POST', comments(id), 1, { text: 'Read only' }), 403);
    await expectResponse(write(f, manager, 'POST', comments(id), 1, { text: 'Read only manager' }), 403);
    await expectResponse(write(f, admin, 'POST', comments(id), 1, { text: 'Outside' }), 404);
    await expectResponse(write(f, author, 'POST', comments(id), 1, { text: '   ' }), 422, 'INVALID_REQUEST');

    const text = [mention(ids.secondEditor), mention(ids.secondEditor), '\\' + mention(ids.viewer),
      mention(ids.commentingViewer), mention(ids.disabledMember), mention(ids.admin), '<strong>Exact comment</strong>'].join(' ');
    const key = randomUUID();
    const made = await data(write(f, author, 'POST', comments(id), 1, { text }, key), 201);
    assert.deepEqual(await data(write(f, author, 'POST', comments(id), 1, { text }, key), 201), made);
    assert.equal(made.cardRevision, 2);
    assert.equal((await row(f, 'cardFollows', automatic)).isPermanent, true);
    assert.equal((await row(f, 'comments', made.id)).text, text);
    const deliveries = await f.db.collection('notifications').find({ ...f.scope, commentId: made.id }).toArray();
    assert.deepEqual(deliveries.map(({ recipientId, kind }) => [recipientId, kind]).sort(), [
      [ids.secondEditor, 'mentionInComment'], [ids.viewer, 'commentCard'],
    ].sort());
    assert.equal((await expectResponse(f.call(inbox, other), 200)).data.unreadCount, 1);
    assert.equal((await expectResponse(f.call(inbox, author), 200)).data.unreadCount, 0);

    const authorRead = (await data(f.call(comments(id), author)))[0];
    assert.deepEqual(authorRead.permissions, { canEdit: true, canDelete: true });
    assert.deepEqual((await data(f.call(comments(id), manager)))[0].permissions, { canEdit: false, canDelete: true });
    assert.deepEqual((await data(f.call(comments(id), viewer)))[0].permissions, { canEdit: false, canDelete: false });
    const edited = await data(write(f, author, 'PATCH', comment(made.id), 1, { text: 'Changed ' + mention(ids.firstEditor) }));
    assert.deepEqual([edited.revision, edited.cardRevision], [2, 3]);
    assert.equal(await f.db.collection('notifications').countDocuments({ ...f.scope, commentId: made.id }), 2);
    await expectResponse(write(f, editor, 'PATCH', comment(made.id), 2, { text: 'Impersonation' }), 403);
    await expectResponse(write(f, manager, 'PATCH', comment(made.id), 2, { text: 'Impersonation' }), 403);

    await f.gate.runCommand(() => f.db.collection('boardMembers').updateOne(
      { ...f.scope, boardId: ids.privateBoard, userId: ids.commentingViewer }, { $set: { canComment: false } }));
    await expectResponse(write(f, author, 'PATCH', comment(made.id), 2, { text: 'No longer allowed' }), 403);
    await expectResponse(write(f, author, 'DELETE', comment(made.id), 2), 403);
    await data(write(f, editor, 'POST', card(id) + '/archive', 3, { sourceOrderVersion: 1, destinationOrderVersion: 1 }));
    await expectResponse(write(f, author, 'POST', comments(id), 4, { text: 'Historical view' }), 403);
    const deletionKey = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const removed = await expectResponse(write(f, manager, 'DELETE', comment(made.id), 2, undefined, deletionKey), 204);
      assert.equal(removed.headers[relationshipParentRevisionHeader], '5');
    }
    assert.equal(await row(f, 'comments', made.id), null);
    assert.equal(await f.db.collection('notifications').countDocuments({ ...f.scope, commentId: made.id }), 0);
    const contentFree = await f.db.collection('events').find({ ...f.scope, boardId: ids.privateBoard, kind: 'board.invalidated' }).toArray();
    assert.ok(contentFree.length >= 3);
    assert.ok(contentFree.every(({ payload }) => Object.keys(payload).length === 0));
    const shared = await data(write(f, editor, 'POST', comments(ids.sharedTarget), 1, { text: 'Shared board' }), 201);
    await expectResponse(write(f, admin, 'DELETE', comment(shared.id), 1), 403);
  });
});

test('inbox counts and scoped activity pages ignore orphan, inaccessible and staged rows before query results', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const viewer = await signIn(f, ids.viewer);
    const other = await signIn(f, ids.secondEditor);
    const knownComment = fixtureId(701);
    const oldActivity = fixtureId(711);
    const orphan = fixtureId(721);
    const historical = fixtureId(722);
    const ownUnread = fixtureId(723);
    const invisible = fixtureId(724);
    const cards = { boardId: ids.privateBoard, cardId: ids.activeCard };
    await f.insert('comments', knownComment, { ...cards, authorId: null, text: 'A historical comment' });
    await f.insert('activities', oldActivity, { boardId: null, cardId: ids.archivedStory, actorId: ids.firstEditor,
      kind: 'moveCard', fromList: { id: fixtureId(799), name: 'Restricted old list name' } });
    await f.insert('activities', fixtureId(712), { ...cards, kind: 'createCard', actorId: ids.firstEditor });
    await f.insert('notifications', orphan, { ...cards, recipientId: ids.viewer, actorId: ids.firstEditor,
      kind: 'moveCard', activityId: fixtureId(799), readAt: null, snapshot: { text: 'Orphan detail' } });
    await f.insert('notifications', historical, { ...cards, recipientId: ids.viewer, actorId: ids.firstEditor,
      kind: 'commentCard', commentId: knownComment, readAt: new Date('2026-03-19T13:02:00.000Z') });
    await f.db.collection('notifications').updateOne({ ...f.scope, id: historical }, { $unset: { revision: '' } });
    await f.insert('notifications', ownUnread, { ...cards, recipientId: ids.viewer, actorId: ids.firstEditor,
      kind: 'commentCard', commentId: knownComment, readAt: null });
    await f.insert('comments', fixtureId(702), { boardId: ids.sharedBoard, cardId: ids.sharedTarget, authorId: ids.firstEditor, text: 'Hidden board text' });
    await f.insert('notifications', invisible, { boardId: ids.sharedBoard, cardId: ids.sharedTarget, commentId: fixtureId(702),
      recipientId: ids.viewer, actorId: ids.firstEditor, kind: 'mentionInComment', readAt: null });
    await f.insert('notifications', fixtureId(725), { ...cards, recipientId: ids.secondEditor, actorId: ids.firstEditor,
      kind: 'commentCard', commentId: knownComment, readAt: null });
    await f.insert('notifications', ownUnread, { ...cards, recipientId: ids.viewer, kind: 'commentCard', commentId: knownComment, readAt: null },
      f.stagedGenerationId);
    const first = (await expectResponse(f.call(inbox + '?limit=1', viewer), 200)).data;
    assert.equal(first.unreadCount, 1);
    assert.deepEqual(first.data.map(({ id }) => id), [ownUnread]);
    assert.ok(first.page.nextCursor);
    const next = new URLSearchParams({ limit: '1', cursor: first.page.nextCursor });
    assert.deepEqual((await data(f.call(inbox + '?' + next, viewer))).map(({ id, revision }) => [id, revision]), [[historical, null]]);
    await expectResponse(f.call(inbox + '?' + next, other), 422, 'INVALID_CURSOR');
    next.set('unread', 'true');
    await expectResponse(f.call(inbox + '?' + next, viewer), 422, 'INVALID_CURSOR');
    await expectResponse(write(f, viewer, 'PATCH', notice(orphan), 1, { read: true }), 404);
    await expectResponse(write(f, viewer, 'PATCH', notice(invisible), 1, { read: true }), 404);
    await expectResponse(write(f, other, 'PATCH', notice(ownUnread), 1, { read: true }), 404);
    const marked = await data(write(f, viewer, 'PATCH', notice(ownUnread), 1, { read: true }));
    assert.deepEqual([marked.revision, marked.readAt], [2, (await row(f, 'notifications', ownUnread)).readAt.toISOString()]);
    await expectResponse(write(f, viewer, 'PATCH', notice(ownUnread), 1, { read: false }), 409, 'REVISION_CONFLICT');
    assert.equal((await expectResponse(f.call(inbox + '?unread=true', viewer), 200)).data.unreadCount, 0);
    await data(write(f, viewer, 'PATCH', notice(ownUnread), 2, { read: false }));
    const key = randomUUID();
    assert.deepEqual(await data(write(f, viewer, 'POST', card(ids.activeCard) + '/notifications/read', undefined, undefined, key)), { acknowledged: true });
    assert.equal((await row(f, 'cards', ids.activeCard)).revision, 1);
    assert.equal((await row(f, 'notifications', orphan)).readAt, null);
    assert.equal((await row(f, 'notifications', invisible)).readAt, null);
    assert.equal((await row(f, 'notifications', fixtureId(725))).readAt, null);
    assert.equal((await f.db.collection('notifications').findOne({ generationId: f.stagedGenerationId, id: ownUnread })).readAt, null);
    const legacy = await data(write(f, viewer, 'PATCH', notice(historical), 0, { read: false }));
    assert.deepEqual([legacy.revision, legacy.readAt], [1, null]);
    await data(write(f, viewer, 'PATCH', notice(historical), 1, { read: true }));

    const previousBoard = fixtureId(20110);
    await f.insert('activities', previousBoard, {
      cardId: ids.archivedStory, boardId: ids.sharedBoard, actorId: ids.projectManager, kind: 'moveCard',
      fromList: { id: fixtureId(20111), name: 'Restricted previous list' },
    });
    const retainedNotice = fixtureId(20112);
    await f.insert('notifications', retainedNotice, {
      cardId: ids.archivedStory, boardId: ids.sharedBoard, actorId: ids.projectManager, recipientId: ids.viewer,
      activityId: previousBoard, kind: 'moveCard', readAt: new Date('2026-03-19T13:03:00.000Z'),
    });
    const priorHistory = await data(f.call(card(ids.archivedStory) + '/activity', viewer));
    const previous = priorHistory.find(({ id }) => id === previousBoard);
    assert.deepEqual([previous.card.boardId, previous.actor], [ids.privateBoard, null]);
    assert.equal(JSON.stringify(previous).includes(ids.sharedBoard), false);
    assert.equal(JSON.stringify(previous).includes('Restricted previous list'), false);
    const previousNotice = (await data(f.call(inbox, viewer))).find(({ id }) => id === retainedNotice);
    assert.deepEqual([previousNotice.card.boardId, previousNotice.actor], [ids.privateBoard, null]);
    const historic = priorHistory.find(({ id }) => id === oldActivity);
    assert.equal(historic.card.kind, 'archive');
    assert.equal(historic.kind, 'moveCard');
    assert.equal(JSON.stringify(historic).includes('Restricted old list name'), false);
    await expectResponse(f.call(card(ids.archivedStory) + '/activity?boardId=' + ids.sharedBoard, viewer), 404);
    const activityFirst = (await expectResponse(f.call(board(ids.privateBoard) + '/activity?limit=1', viewer), 200)).data;
    assert.ok(activityFirst.page.nextCursor);
    await expectResponse(f.call(card(ids.activeCard) + '/activity?' + new URLSearchParams({
      limit: '1', cursor: activityFirst.page.nextCursor,
    }), viewer), 422, 'INVALID_CURSOR');
    assert.equal((await data(f.call(comments(ids.activeCard), viewer)))[0].author, null);
  });
});

test('interrupted comment preparation recovers once and a read-all replay preserves later delivery', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    await f.insert('boardFollows', fixtureId(20130), { boardId: ids.privateBoard, userId: ids.viewer });
    const token = readSessionCookie(editor);
    const key = randomUUID();
    const body = { text: 'Durable delivery' };
    const journal = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), 'web', key),
      checkpoint(point, index) { if (point === 'effectApplied' && index === 0) throw new Error('Isolated interruption'); },
    });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId: 'comments.create', idempotencyKey: key,
      input: { id: ids.activeCard, expectedRevision: 1, ...body } }));
    assert.equal(f.gate.ready, false);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const made = await data(write(f, editor, 'POST', comments(ids.activeCard), 1, body, key), 201);
    assert.equal((await data(f.call(comments(ids.activeCard), viewer))).length, 1);
    assert.equal(await f.db.collection('notifications').countDocuments({ ...f.scope, commentId: made.id }), 1);

    const readKey = randomUUID();
    const readAll = () => write(f, viewer, 'POST', inbox + '/read-all', undefined, undefined, readKey);
    const prepared = Promise.withResolvers();
    const release = Promise.withResolvers();
    const readerToken = readSessionCookie(viewer);
    const marking = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () => resolveBrowserWorkspace(f.db, f.installationId, readerToken, f.now()), 'web', readKey),
      async checkpoint(point) {
        if (point === 'prepared') { prepared.resolve(); await release.promise; }
      },
    }).execute({ actorId: ids.viewer, operationId: 'notifications.readAll', idempotencyKey: readKey, input: {} });
    await Promise.race([prepared.promise, marking]);
    const laterDelivery = data(write(f, editor, 'POST', comments(ids.activeCard), 2, { text: 'Later update' }), 201);
    release.resolve();
    await marking;
    const second = await laterDelivery;
    await expectResponse(readAll(), 200);
    const after = (await expectResponse(f.call(inbox + '?unread=true', viewer), 200)).data;
    assert.equal(after.unreadCount, 1);
    const later = await row(f, 'notifications', after.data[0].id);
    assert.equal(later.commentId, second.id);
    assert.equal(later.readAt, null);
  });
});

test('actual activity producers remain scoped when a card and its comments transfer', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const editor = await signIn(f, ids.firstEditor);
    const viewer = await signIn(f, ids.viewer);
    const destinationReader = await signIn(f, ids.projectManager);
    const both = await signIn(f, ids.secondEditor);
    await f.insert('boardMembers', fixtureId(20159), { boardId: ids.sharedBoard, userId: ids.secondEditor, role: 'viewer', canComment: false });
    const privateActivity = board(ids.privateBoard) + '/activity';
    const currentRevision = async (id) => (await data(f.call(card(id), editor))).revision;
    const made = await data(write(f, editor, 'POST', '/api/v1/lists/' + ids.privateActiveList + '/cards', 1,
      { name: 'Activity scope fixture' }), 201);
    const id = made.card.id;
    const assigned = card(id) + '/assignees/' + ids.secondEditor;
    await data(write(f, editor, 'PUT', assigned, 1));
    await expectResponse(write(f, editor, 'DELETE', assigned, 2), 204);
    const checklist = (await data(write(f, editor, 'POST', card(id) + '/checklists', 3, { name: 'Record observations' }), 201)).checklist;
    const task = (await data(write(f, editor, 'POST', '/api/v1/checklists/' + checklist.id + '/tasks', checklist.revision,
      { name: 'Repeat the measurement' }), 201)).task;
    await data(write(f, editor, 'PATCH', '/api/v1/tasks/' + task.id, task.revision, { completed: true }));
    await data(write(f, editor, 'PATCH', '/api/v1/tasks/' + task.id, task.revision + 1, { completed: false }));
    const end = await currentRevision(id);
    const moved = await data(write(f, editor, 'POST', card(id) + '/move', end, {
      toListId: ids.privateClosedList, beforeCardId: null, sourceOrderVersion: 2, destinationOrderVersion: 1,
    }));
    const kinds = (await data(f.call(card(id) + '/activity', viewer))).map(({ kind }) => kind).sort();
    assert.deepEqual(kinds, ['assignCard', 'completeTask', 'createCard', 'moveCard', 'unassignCard', 'uncompleteTask'].sort());
    assert.equal((await data(f.call(privateActivity, viewer))).filter((item) => item.card.id === id).length, 6);

    await f.insert('boardFollows', fixtureId(20160), { boardId: ids.privateBoard, userId: ids.viewer });
    await f.insert('boardFollows', fixtureId(20161), { boardId: ids.privateBoard, userId: ids.secondEditor });
    const boardless = fixtureId(20162);
    await f.insert('activities', boardless, { boardId: null, cardId: id, actorId: ids.privateOwner, kind: 'moveCard',
      fromList: { id: fixtureId(20163), name: 'Restricted old name' } });
    const text = 'Carry the existing discussion';
    const authorKey = randomUUID();
    const authored = await data(write(f, editor, 'POST', comments(id), moved.card.revision, { text }, authorKey), 201);
    const delivered = (await data(f.call(inbox, viewer))).find((entry) => entry.card.id === id);
    assert.ok(delivered);
    const cross = await data(write(f, editor, 'POST', card(id) + '/move', authored.cardRevision, {
      toListId: ids.sharedActiveList, destinationBoardId: ids.sharedBoard, beforeCardId: null, sourceOrderVersion: 2, destinationOrderVersion: 1,
    }));
    assert.equal(cross.card.boardId, ids.sharedBoard);
    await expectResponse(f.call(comments(id) + '?boardId=' + ids.privateBoard, editor), 404);
    await expectResponse(f.call(comments(id), viewer), 404);
    await expectResponse(write(f, viewer, 'PATCH', notice(delivered.id), 1, { read: true }), 404);
    assert.equal((await data(f.call(inbox, viewer))).some((entry) => entry.card.id === id), false);
    assert.equal((await data(f.call(privateActivity, viewer))).some((entry) => entry.card.id === id), false);

    const destination = (await data(f.call(comments(id) + '?boardId=' + ids.sharedBoard, destinationReader)))[0];
    assert.deepEqual([destination.id, destination.text, destination.revision], [authored.id, text, 2]);
    const history = await data(f.call(card(id) + '/activity', destinationReader));
    assert.equal(history.length, 8);
    assert.ok(history.every(({ card }) => card.boardId === ids.sharedBoard));
    assert.deepEqual(history.filter(({ actor }) => actor).map(({ kind, actor }) => [kind, actor.id]), [['moveCard', ids.firstEditor]]);
    assert.equal(history.find(({ id }) => id === boardless).actor, null);
    assert.equal(JSON.stringify(history).includes('Restricted old name'), false);
    assert.equal((await data(f.call(board(ids.sharedBoard) + '/activity', destinationReader))).filter((entry) => entry.card.id === id).length, 8);
    const retainedDelivery = (await data(f.call(inbox, both))).find((entry) => entry.card.id === id && entry.kind === 'commentCard');
    assert.equal(retainedDelivery.card.boardId, ids.sharedBoard);
    assert.equal(retainedDelivery.actor, null);
    assert.equal(await f.db.collection('activities').countDocuments({ ...f.scope, boardId: ids.privateBoard, cardId: id }), 6);
    await expectResponse(write(f, editor, 'POST', comments(id), moved.card.revision, { text }, authorKey), 404);
    await data(write(f, editor, 'PATCH', comment(authored.id), destination.revision, { text: 'Updated in its current board' }));
  });
});
