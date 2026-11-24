import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { boardEventFrameSchema } from '@planner/contracts';
import { Long } from 'mongodb';
import { csrfToken, readSessionCookie, tokenDigest } from '../../apps/backend/dist/application/auth/credentials.js';
import { createBoardEventCursors } from '../../apps/backend/dist/application/board-events/cursor.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { proxyHeaders } from '../support/account-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const boardPath = (boardId) => '/api/v1/boards/' + boardId;
const eventPath = (boardId) => boardPath(boardId) + '/events';

async function login(f, actorId) {
  const result = await f.login(actorId);
  assert.equal(result.status, 200);
  const cookie = cookieOf(result);
  assert.ok(cookie);
  return cookie;
}

function mutate(f, cookie, path, method, revision, body) {
  return f.call(path, cookie, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)),
    'Idempotency-Key': randomUUID(), 'If-Match': '"' + revision + '"',
  } });
}

async function snapshot(f, boardId, cookie) {
  const result = await f.call(boardPath(boardId) + '/workspace', cookie);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.data;
}

async function open(f, boardId, cookie, { after, headers = {} } = {}) {
  const path = eventPath(boardId) + (after === undefined ? '' : '?after=' + encodeURIComponent(after));
  const response = await new Promise((resolve, reject) => {
    const req = request({ socketPath: f.socketPath, path, headers: { ...proxyHeaders(origin), Cookie: cookie, ...headers } }, resolve);
    req.once('error', reject).end();
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream/u);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-accel-buffering'], 'no');
  const wake = new EventEmitter();
  const queue = [];
  let buffer = '';
  let closed = false;
  function end() { closed = true; wake.emit('change'); }
  response.setEncoding('utf8');
  response.on('data', (data) => {
    buffer += data;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const field = buffer.slice(0, boundary).split('\n');
      buffer = buffer.slice(boundary + 2);
      if (field[0] === ': heartbeat') queue.push({ heartbeat: true });
      else {
        const get = (prefix) => field.find((line) => line.startsWith(prefix))?.slice(prefix.length);
        const value = boardEventFrameSchema.parse({ event: get('event: '), data: JSON.parse(get('data: ')) });
        queue.push({ ...value, id: get('id: ') });
      }
    }
    wake.emit('change');
  });
  response.on('close', end).on('error', end);
  return {
    close: () => response.destroy(),
    async next({ heartbeat = false } = {}) {
      const deadline = AbortSignal.timeout(15_000);
      while (true) {
        while (queue.length) {
          const message = queue.shift();
          if (heartbeat || !message.heartbeat) return message;
        }
        if (closed) return null;
        await once(wake, 'change', { signal: deadline });
      }
    },
  };
}

function event(f, boardId, sequence, kind = 'board.access-changed', payload = {}) {
  const id = randomUUID();
  return { _id: workspaceKey(f.generationId, id), ...f.scope, id, boardId, kind, payload, sequence: Long.fromBigInt(sequence) };
}

async function append(f, ...events) {
  await f.gate.runCommand(() => f.db.collection('events').insertMany(events));
}

function cursor(f, actorId, boardId, sequence) {
  return f.cursors.encode({ actorId, boardId, generationId: f.generationId }, sequence);
}

async function reset(f, boardId, cookie, options) {
  const stream = await open(f, boardId, cookie, options);
  try {
    assert.deepEqual(await stream.next(), { event: 'reset', data: { boardId }, id: undefined });
    assert.equal(await stream.next(), null);
  } finally { stream.close(); }
}

test('authorized HTTP snapshots and reconnects share a restart-stable, scope-bound replay cursor', { timeout: 180_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo, { heartbeatMs: 250 });
    try {
      const viewer = await login(f, ids.viewer);
      const admin = await login(f, ids.admin);
      const owner = await login(f, ids.privateOwner);
      assert.equal((await f.call(eventPath(ids.privateBoard))).status, 401);
      assert.equal((await f.call(eventPath(ids.privateBoard), admin)).status, 404);
      assert.equal((await f.call(eventPath(ids.privateBoard), viewer, { headers: { Origin: 'https://other.invalid' } })).status, 403);
      assert.equal((await f.call(eventPath(ids.privateBoard), viewer, { headers: { 'X-Forwarded-Host': 'other.invalid' } })).status, 401);
      const empty = await snapshot(f, ids.privateBoard, viewer);
      assert.equal(empty.latestEventSequence, '0');
      const codec = createBoardEventCursors(f.cursorKey);
      assert.equal(codec.decode({ actorId: ids.viewer, boardId: ids.privateBoard, generationId: f.generationId }, empty.eventCursor), 0n);

      const firstConnection = await open(f, ids.privateBoard, viewer);
      const ready = await firstConnection.next();
      assert.deepEqual(ready, { event: 'ready', data: { boardId: ids.privateBoard }, id: empty.eventCursor });
      firstConnection.close();
      await append(f, event(f, ids.privateBoard, 1n));
      const firstReconnect = await open(f, ids.privateBoard, viewer, { headers: { 'Last-Event-ID': ready.id } });
      try {
        assert.deepEqual(await firstReconnect.next(), {
          event: 'board.access-changed', data: { boardId: ids.privateBoard }, id: cursor(f, ids.viewer, ids.privateBoard, 1n),
        });
      } finally { firstReconnect.close(); }
      await append(f, ...Array.from({ length: 1_000 }, (_, index) => event(f, ids.privateBoard, BigInt(index + 2))));
      await reset(f, ids.privateBoard, viewer, { after: empty.eventCursor });
      await reset(f, ids.privateBoard, owner, { after: cursor(f, ids.viewer, ids.privateBoard, 1_001n) });
      await reset(f, ids.privateBoard, viewer, { after: cursor(f, ids.viewer, ids.sharedBoard, 1_001n) });
      await reset(f, ids.privateBoard, viewer, { after: cursor(f, ids.viewer, ids.privateBoard, 1_002n) });
      await reset(f, ids.privateBoard, viewer, { after: cursor(f, ids.viewer, ids.privateBoard, 1_000n), headers: { 'Last-Event-ID': 'not-valid' } });
      await reset(f, ids.privateBoard, viewer, { after: codec.encode({
        actorId: ids.viewer, boardId: ids.privateBoard, generationId: f.stagedGenerationId,
      }, 1_001n) });

      const live = await open(f, ids.privateBoard, viewer);
      try {
        assert.deepEqual(await live.next(), { event: 'ready', data: { boardId: ids.privateBoard },
          id: cursor(f, ids.viewer, ids.privateBoard, 1_001n) });
        assert.deepEqual(await live.next({ heartbeat: true }), { heartbeat: true });
      } finally { live.close(); }
      const replay = await open(f, ids.privateBoard, viewer, { after: 'invalid', headers: { 'Last-Event-ID': cursor(f, ids.viewer, ids.privateBoard, 1n) } });
      try {
        for (let sequence = 2n; sequence <= 1_001n; sequence++) {
          assert.deepEqual(await replay.next(), {
            event: 'board.access-changed', data: { boardId: ids.privateBoard }, id: cursor(f, ids.viewer, ids.privateBoard, sequence),
          });
        }
        assert.deepEqual(await replay.next({ heartbeat: true }), { heartbeat: true });
      } finally { replay.close(); }

      await f.gate.runCommand(() => f.db.collection('events').deleteOne({ ...f.scope, boardId: ids.privateBoard, sequence: Long.fromBigInt(1_000n) }));
      await reset(f, ids.privateBoard, viewer, { after: cursor(f, ids.viewer, ids.privateBoard, 998n) });

      const large = 9_007_199_254_740_993n;
      await append(f, event(f, ids.sharedBoard, large), event(f, ids.sharedBoard, large + 1n));
      const high = await snapshot(f, ids.sharedBoard, admin);
      assert.equal(high.latestEventSequence, String(large + 1n));
      const single = await open(f, ids.sharedBoard, admin, { after: cursor(f, ids.admin, ids.sharedBoard, large) });
      try { assert.equal((await single.next()).id, high.eventCursor); } finally { single.close(); }
    } finally { await f.close(); }
  });
});

test('outbox acknowledgement and concurrent live access changes do not duplicate or leak frames', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo, { heartbeatMs: 120 });
    const dispatch = () => new CommandJournal(f.gate, f.db, f.installationId).deliverPending(f.streams.accept);
    try {
      const owner = await login(f, ids.privateOwner);
      const viewer = await login(f, ids.viewer);
      const viewerMember = boardPath(ids.privateBoard) + '/members/' + ids.viewer;
      const base = (await snapshot(f, ids.privateBoard, viewer)).eventCursor;
      assert.equal((await mutate(f, owner, viewerMember, 'PATCH', 1, { canComment: true })).status, 200);

      const stream = await open(f, ids.privateBoard, viewer, { after: base });
      try {
        assert.equal((await stream.next()).id, cursor(f, ids.viewer, ids.privateBoard, 1n));
        const firstDispatcher = new CommandJournal(f.gate, f.db, f.installationId, {
          checkpoint(point) { if (point === 'afterDelivery') throw new Error('test delivery interruption'); },
        });
        await assert.rejects(firstDispatcher.deliverPending(f.streams.accept), /test delivery interruption/u);
        assert.equal(await f.db.collection('commands').countDocuments({ ...f.scope, outboxPending: true }), 1);
        await dispatch();
        assert.equal(await f.db.collection('commands').countDocuments({ ...f.scope, outboxPending: true }), 0);
        assert.deepEqual(await stream.next({ heartbeat: true }), { heartbeat: true });

        assert.equal((await mutate(f, owner, viewerMember, 'PATCH', 2, { canComment: false })).status, 200);
        await dispatch();
        assert.equal((await stream.next()).id, cursor(f, ids.viewer, ids.privateBoard, 2n));
        assert.equal((await mutate(f, owner, viewerMember, 'DELETE', 3)).status, 204);
        assert.equal((await f.call(eventPath(ids.privateBoard), viewer)).status, 404);
        // Regrant before any outbox pass. The original socket must already be terminal.
        assert.equal((await mutate(f, owner, boardPath(ids.privateBoard) + '/members', 'POST', 4,
          { userId: ids.viewer, role: 'viewer' })).status, 201);
        await dispatch();
        assert.equal(await stream.next(), null);
        const regranted = await open(f, ids.privateBoard, viewer);
        try {
          assert.equal((await regranted.next()).event, 'ready');
          assert.deepEqual(await regranted.next({ heartbeat: true }), { heartbeat: true });
        } finally { regranted.close(); }
      } finally { stream.close(); }

      const manager = await open(f, ids.privateBoard, owner);
      try {
        assert.equal((await manager.next()).event, 'ready');
        const self = boardPath(ids.privateBoard) + '/members/' + ids.privateOwner;
        assert.equal((await mutate(f, owner, self, 'DELETE', 1)).status, 204);
        await dispatch();
        assert.equal((await manager.next()).event, 'board.access-changed');
        assert.equal((await snapshot(f, ids.privateBoard, owner)).board.permissions.canManage, true);
      } finally { manager.close(); }

      const admin = await login(f, ids.admin);
      const projectManager = await login(f, ids.projectManager);
      assert.equal((await mutate(f, projectManager, boardPath(ids.sharedBoard) + '/members', 'POST', 1,
        { userId: ids.admin, role: 'viewer' })).status, 201);
      await dispatch();
      const inherited = await open(f, ids.sharedBoard, admin);
      try {
        assert.equal((await inherited.next()).event, 'ready');
        assert.equal((await mutate(f, admin, boardPath(ids.sharedBoard) + '/members/' + ids.admin, 'DELETE', 1)).status, 204);
        await dispatch();
        assert.equal((await inherited.next()).event, 'board.access-changed');
        await f.gate.runCommand(async () => {
          await f.db.collection('users').updateOne({ ...f.scope, id: ids.admin }, { $set: { role: 'boardUser' } });
          await f.streams.revalidateActor(f.db, ids.admin);
        });
        assert.equal(await inherited.next(), null);
      } finally { inherited.close(); }
    } finally { await f.close(); }
  });
});

test('the stream allowlist projects only authorized card effects and passively checks session expiry', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    let time = new Date('2026-03-19T13:13:59.719Z');
    const f = await makeWorkspaceAccessFixture(mongo, { clock: () => time, heartbeatMs: 100 });
    try {
      const source = await login(f, ids.viewer);
      const destination = await login(f, ids.admin);
      const destinationToken = readSessionCookie(destination);
      const match = { ...f.scope, tokenDigest: tokenDigest(destinationToken) };
      const originalSession = await f.db.collection('sessions').findOne(match);
      const originalSource = await snapshot(f, ids.privateBoard, source);
      const originalDestination = await snapshot(f, ids.sharedBoard, destination);
      const outside = { id: ids.sharedTarget, revision: 1, destinationBoardId: ids.sharedBoard, name: 'Private linked target' };
      await append(f,
        event(f, ids.privateBoard, 1n, 'card.removed', { ...outside, id: ids.activeCard }),
        event(f, ids.privateBoard, 2n, 'card.changed', outside),
        event(f, ids.privateBoard, 3n, 'unknown.private-payload', outside),
        event(f, ids.sharedBoard, 1n, 'card.changed', outside),
        event(f, ids.sharedBoard, 2n, 'card.mediaChanged', outside),
      );
      time = new Date(time.getTime() + 10_000);
      const oldBoard = await open(f, ids.privateBoard, source, { after: originalSource.eventCursor });
      const newBoard = await open(f, ids.sharedBoard, destination, { after: originalDestination.eventCursor });
      try {
        const visible = await oldBoard.next();
        assert.deepEqual(visible.data, { boardId: ids.privateBoard, id: ids.activeCard });
        assert.equal(visible.event, 'card.removed');
        for (let index = 0; index < 2; index++) {
          const hidden = await oldBoard.next();
          assert.deepEqual({ event: hidden.event, data: hidden.data }, { event: 'board.invalidated', data: { boardId: ids.privateBoard } });
        }
        for (const kind of ['card.changed', 'card.mediaChanged']) {
          const delivered = await newBoard.next();
          assert.deepEqual({ event: delivered.event, data: delivered.data },
            { event: kind, data: { boardId: ids.sharedBoard, id: ids.sharedTarget, revision: 1 } });
        }
        assert.deepEqual(await newBoard.next({ heartbeat: true }), { heartbeat: true });
        assert.deepEqual((await f.db.collection('sessions').findOne(match)).lastActivityAt, originalSession.lastActivityAt);
        time = new Date(time.getTime() + 13 * 60 * 60_000);
        assert.equal(await newBoard.next(), null);
        assert.equal((await f.call(eventPath(ids.sharedBoard), destination)).status, 401);
      } finally { oldBoard.close(); newBoard.close(); }
    } finally { await f.close(); }
  });
});

test('logout closes only its stream, stale generation closes the survivor, and a slow sink drops pending frames', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo, { heartbeatMs: 120 });
    try {
      const first = await login(f, ids.viewer);
      const second = await login(f, ids.viewer);
      const firstStream = await open(f, ids.privateBoard, first);
      const secondStream = await open(f, ids.privateBoard, second);
      try {
        assert.equal((await firstStream.next()).event, 'ready');
        assert.equal((await secondStream.next()).event, 'ready');
        assert.equal((await mutate(f, first, '/api/v1/session', 'DELETE', 1)).status, 204);
        assert.equal(await firstStream.next(), null);
        assert.deepEqual(await secondStream.next({ heartbeat: true }), { heartbeat: true });

        await append(f, event(f, ids.privateBoard, 1n), event(f, ids.privateBoard, 2n));
        const sent = [];
        const slow = new AbortController();
        const completed = new EventEmitter();
        const final = once(completed, 'closed', { signal: AbortSignal.timeout(10_000) });
        await f.streams.subscribe(readSessionCookie(second), ids.privateBoard, cursor(f, ids.viewer, ids.privateBoard, 0n), {
          begin() {},
          frame(frame) { sent.push(frame); return false; },
          heartbeat: () => true,
          close(abort) { completed.emit('closed', abort); },
        }, slow.signal);
        assert.deepEqual(await final, [true]);
        await f.gate.runCommand(() => f.db.collection('installation').updateOne({ _id: 'installation', installationId: f.installationId },
          { $set: { activeGenerationId: f.stagedGenerationId } }));
        assert.equal(await secondStream.next(), null);
        assert.equal(sent.length, 1);
      } finally { firstStream.close(); secondStream.close(); }
    } finally { await f.close(); }
  });
});
