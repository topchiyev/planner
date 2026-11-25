import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Secret, TOTP } from 'otpauth';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { createMcpBoardSubscriptions } from '../../apps/backend/dist/application/mcp/board-subscriptions.js';
import { createReadMcpSurface } from '../../apps/backend/dist/application/mcp/read-surface.js';
import { createNativeOAuthRuntime } from '../../apps/backend/dist/native/oauth-routes.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { password } from '../support/account-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { client, collectHttps, consentReader, form, httpsCall, httpsOpen, legacy, modern, rpcCall, rpcOptions, sdkHttpsFetch } from '../support/mcp-https-fixture.mjs';
import { tlsBridge } from '../support/tls-bridge.mjs';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture } from '../support/workspace-access-fixture.mjs';

const subscriptionId = 'io.modelcontextprotocol/subscriptionId';
const boardUri = 'planner://boards/' + ids.privateBoard;
const destinationUri = 'planner://boards/' + ids.sharedBoard;
const cardUri = 'planner://cards/' + ids.activeCard;
const notifications = (...uris) => ({ notifications: { resourceSubscriptions: uris } });
const open = (response) => response.headers['content-type']?.startsWith('text/event-stream');
const activeToken = (token) => token.access_token;

function stream(response) {
  async function* frames() {
    let buffer = '';
    try {
      for await (const chunk of response) {
        buffer += chunk.toString('utf8');
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) break;
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) yield JSON.parse(data.slice(6));
          else if (frame === ': keepalive') yield { heartbeat: true };
        }
      }
    } catch (error) {
      if (!['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) throw error;
    }
  }
  const iterator = frames();
  return {
    close: () => response.destroy(),
    async next(wantHeartbeat = false) {
      for (;;) {
        const { done, value } = await iterator.next();
        if (done) return null;
        if (wantHeartbeat || !value.heartbeat) return value;
      }
    },
  };
}

function ack(frame, uris, id = 1) {
  assert.deepEqual(frame, { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
    params: { notifications: { resourceSubscriptions: uris }, _meta: { [subscriptionId]: id } } });
}

function update(frame, uri, id = 1) {
  assert.deepEqual(frame, { jsonrpc: '2.0', method: 'notifications/resources/updated',
    params: { uri, _meta: { [subscriptionId]: id } } });
}

async function signIn(f, call, origin, id, key, time) {
  const signup = await f.login(id);
  const sessionToken = readSessionCookie(cookieOf(signup));
  assert.ok(sessionToken);
  const pending = await f.manage.begin({ sessionToken });
  const otp = new TOTP({ secret: Secret.fromBase32(pending.secret), issuer: 'Planner', digits: 6, period: 30, algorithm: 'SHA1' });
  assert.ok(await f.manage.confirm({ sessionToken, enrollmentId: pending.enrollmentId }, otp.generate({ timestamp: time.value })));
  time.value += 30_000;
  const cookies = new Map();
  async function login() {
    const post = (path, body) => call(path, { method: 'POST', cookies, body, headers: { Origin: origin } });
    const check = await post('/api/v1/session/login', { identifier: key + '@planner.invalid', password });
    assert.equal(check.value.status, 'challenge-required', check.text);
    const verified = await post('/api/v1/session/verify-mfa', {
      challengeId: check.value.challengeId, totpCode: otp.generate({ timestamp: time.value }),
    });
    assert.equal(verified.value.status, 'authenticated', verified.text);
    time.value += 30_000;
    return verified.value.csrfToken;
  }
  return { cookies, login, csrf: await login() };
}

test('modern native TLS subscriptions scope, guard, invalidate and close independently of ordinary browser or other grants',
  { timeout: 100_000 }, () => withFixtureMongo(async (mongo) => {
    const time = { value: Date.now() - 150_000 };
    const boardSubscriptions = createMcpBoardSubscriptions({ heartbeatMs: 180 });
    let f;
    let oauth;
    let beforeProof;
    let beforePublish;
    let slowWrites = 0;
    const tls = await tlsBridge(mongo.directory, async (origin) => {
      f = await makeWorkspaceAccessFixture(mongo, {
        browserOrigin: origin, clock: () => new Date(time.value), mcpBoardSubscriptions: boardSubscriptions,
        configureMcp({ db, installationId, gate, mfaKey, cursors }) {
          oauth = createNativeOAuthRuntime(origin, installationId, gate, mfaKey, (operation) => operation(db), [client],
            undefined, boardSubscriptions.revoked);
          const observed = { ...boardSubscriptions, subscribe(actor, requested, bus, signal) {
            let reads = 0;
            const access = actor.listen;
            const controlled = { ...actor, listen: { ...access, async read(operation) {
              await beforeProof?.(actor, ++reads);
              return access.read(operation);
            } } };
            return boardSubscriptions.subscribe(controlled, requested, {
              subscribe: (handler) => bus.subscribe(handler),
              publish(event) {
                beforePublish?.(actor, event);
                bus.publish(event);
              },
            }, signal);
          } };
          return { oauth, mcp: createReadMcpSurface(origin, cursors, false, observed) };
        },
      });
      return { path: f.socketPath, close: f.close };
    });
    const nativeWrite = ServerResponse.prototype.write;
    // Simulate a full native response socket while keeping the real HTTPS and Unix-socket transport.
    ServerResponse.prototype.write = function (chunk, ...args) {
      if (!this.req?.socket?.remoteAddress && this.req?.headers['x-fixture-slow'] === '1' &&
        Buffer.from(chunk).toString('utf8').includes('notifications/resources/updated')) {
        slowWrites += 1;
        return false;
      }
      return nativeWrite.call(this, chunk, ...args);
    };
    const origin = tls.origin;
    const call = (path, options) => httpsCall(tls, path, options);
    const rpc = (version, method, params, token) => rpcCall(call, version, method, params, token);
    const listen = (token, filters, id = 1, headers, version = modern) => httpsOpen(tls, '/mcp',
      rpcOptions(version, 'subscriptions/listen', filters, token, id, headers));
    const streams = [];
    let sdk;
    async function watch(token, uris, id = 1, headers) {
      const response = await listen(token, notifications(...uris), id, headers);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-accel-buffering'], 'no');
      assert.ok(open(response));
      const watcher = stream(response);
      streams.push(watcher);
      ack(await watcher.next(), uris, id);
      return watcher;
    }
    const delivered = [];
    const journal = new CommandJournal(f.gate, f.db, f.installationId);
    async function dispatch() {
      await journal.deliverPending((signal) => { delivered.push(signal); f.streams.accept(signal); });
    }
    async function browser(path, method, body, cookie, revision = 1) {
      const response = await call(path, { method, body, headers: {
        Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)),
        'If-Match': '"' + revision + '"', 'Idempotency-Key': randomUUID(),
      } });
      assert.ok(response.status === 200 || response.status === 201 || response.status === 204, response.text);
      return response;
    }
    const grantFor = async (id, issuedBefore) => (await f.db.collection('oauthConnections').find({ generationId: f.generationId, userId: id })
      .sort({ issuedAt: 1 }).toArray())[issuedBefore];
    try {
      const viewer = await signIn(f, call, origin, ids.viewer, 'viewer', time);
      const admin = await signIn(f, call, origin, ids.admin, 'admin', time);
      const viewerGrant = await consentReader(call, origin, viewer.cookies, true);
      const independent = await consentReader(call, origin, viewer.cookies);
      const adminGrant = await consentReader(call, origin, admin.cookies);
      const viewerToken = activeToken(viewerGrant);
      const otherToken = activeToken(independent);
      const adminToken = activeToken(adminGrant);
      const viewerId = (await grantFor(ids.viewer, 0)).id;
      const otherId = (await grantFor(ids.viewer, 1)).id;
      const editorCookie = cookieOf(await f.login(ids.firstEditor));
      const ownerCookie = cookieOf(await f.login(ids.privateOwner));

      const modernCapabilities = (await rpc(modern, 'server/discover')).value.result.capabilities;
      const legacyCapabilities = (await rpc(legacy, 'initialize', {
        protocolVersion: legacy, capabilities: {}, clientInfo: { name: 'Board fixture', version: '1' },
      }, viewerToken)).value.result.capabilities;
      assert.deepEqual(modernCapabilities.resources, { listChanged: false, subscribe: true });
      assert.deepEqual(legacyCapabilities.resources, { listChanged: false, subscribe: false });
      assert.equal((await collectHttps(await listen(viewerToken, notifications(boardUri), 1, undefined, legacy))).status, 400);
      assert.equal((await collectHttps(await listen(undefined, notifications(boardUri)))).status, 401);
      for (const invalid of [notifications(), notifications(boardUri, boardUri), notifications(cardUri),
        notifications('planner://boards/*'), notifications(boardUri + '?extra=1'), notifications(...Array.from({ length: 17 }, (_, i) =>
          'planner://boards/' + fixtureId(1900 + i))), { ...notifications(boardUri), after: 'v1.0' },
        { notifications: { resourceSubscriptions: [boardUri], toolsListChanged: true } }]) {
        const refused = await collectHttps(await listen(viewerToken, invalid));
        assert.equal(refused.status, 400, refused.text);
        assert.equal(refused.value.error.code, -32602);
      }
      const invalidCursor = await collectHttps(await listen(viewerToken, notifications(boardUri), 1, { 'Last-Event-ID': 'v1.0' }));
      assert.equal(invalidCursor.status, 400);
      assert.equal((await collectHttps(await listen(viewerToken, notifications(boardUri), 'x'.repeat(4095)))).value.error.code, -32602);
      const denied = await collectHttps(await listen(viewerToken, notifications(boardUri, destinationUri)));
      assert.equal(denied.status, 403);
      assert.equal(denied.text, (await collectHttps(await listen(viewerToken, notifications(destinationUri)))).text);

      // Commit a normal first edit after high-water registration and before the SDK ACK reaches the socket.
      beforeProof = async (actor, count) => {
        if (actor.grantId === viewerId && count === 2) {
          beforeProof = undefined;
          await browser('/api/v1/cards/' + ids.activeCard, 'PATCH', { name: 'Edited while acknowledging' }, editorCookie);
          await dispatch();
        }
      };
      const source = await watch(viewerToken, [boardUri]);
      update(await source.next(), boardUri);
      const other = await watch(otherToken, [boardUri]);
      const destination = await watch(adminToken, [destinationUri, 'planner://boards/' + ids.hiddenBoard]);
      sdk = new Client({ name: 'Board subscription fixture', version: '1' }, { versionNegotiation: { mode: { pin: modern } } });
      await sdk.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => otherToken },
        fetch: (input, init) => sdkHttpsFetch(tls, input, init),
      }), { timeout: 5000 });
      const sdkUpdates = Promise.withResolvers();
      sdk.setNotificationHandler('notifications/resources/updated', (notification) => sdkUpdates.resolve(notification.params.uri));
      const sdkListener = await sdk.listen({ resourceSubscriptions: [boardUri] }, { timeout: 5000 });
      assert.deepEqual(sdkListener.honoredFilter, { resourceSubscriptions: [boardUri] });
      const initial = await rpc(modern, 'resources/read', { uri: cardUri }, viewerToken);
      assert.equal(JSON.parse(initial.value.result.contents[0].text).data.name, 'Edited while acknowledging');

      await browser('/api/v1/cards/' + ids.activeCard + '/move', 'POST', {
        toListId: ids.sharedActiveList, beforeCardId: null, sourceOrderVersion: 1, destinationOrderVersion: 1,
      }, editorCookie, 2);
      await dispatch();
      update(await source.next(), boardUri);
      update(await other.next(), boardUri);
      update(await destination.next(), destinationUri);
      assert.equal(await sdkUpdates.promise, boardUri);
      await sdkListener.close();
      assert.equal(await sdkListener.closed, 'local');
      await sdk.close();
      sdk = undefined;
      async function drainCommitted(watcher, uri, boardId) {
        const maximum = delivered.filter((signal) => signal.boardId === boardId).length;
        for (let index = 0; index < maximum; index += 1) {
          const frame = await watcher.next(true);
          if (frame.heartbeat) return;
          update(frame, uri);
        }
        assert.fail('Outbox delivery exceeded committed signals.');
      }
      await drainCommitted(source, boardUri, ids.privateBoard);
      await drainCommitted(other, boardUri, ids.privateBoard);
      await drainCommitted(destination, destinationUri, ids.sharedBoard);
      for (const signal of delivered) f.streams.accept(signal);
      assert.deepEqual(await source.next(true), { heartbeat: true });
      assert.deepEqual(await destination.next(true), { heartbeat: true });
      assert.equal((await rpc(modern, 'resources/read', { uri: cardUri }, viewerToken)).value.error.code, -32602);
      assert.equal(JSON.parse((await rpc(modern, 'resources/read', { uri: cardUri }, adminToken)).value.result.contents[0].text).data.boardId, ids.sharedBoard);

      const refresh = (refreshToken) => call('/oauth/token', { method: 'POST', type: form, body: {
        grant_type: 'refresh_token', client_id: client.client_id, refresh_token: refreshToken,
      } });
      const refreshed = await refresh(viewerGrant.refresh_token);
      assert.equal(refreshed.status, 200, refreshed.text);
      const regenerated = await watch(refreshed.value.access_token, [boardUri]);
      assert.deepEqual(await source.next(true), { heartbeat: true });
      await oauth.request(() => oauth.storage.adapter('AccessToken').destroy(refreshed.value.access_token));
      assert.equal(await regenerated.next(), null);
      assert.deepEqual(await source.next(true), { heartbeat: true });

      const replayGrant = await consentReader(call, origin, viewer.cookies, true);
      const replayWatcher = await watch(replayGrant.access_token, [boardUri]);
      assert.equal((await refresh(replayGrant.refresh_token)).status, 200);
      const replay = await refresh(replayGrant.refresh_token);
      assert.equal(replay.status, 400, replay.text);
      assert.equal(replay.value.error, 'invalid_grant');
      assert.equal(await replayWatcher.next(), null);
      assert.deepEqual(await other.next(true), { heartbeat: true });

      const slow = await watch(otherToken, [boardUri], 1, { 'x-fixture-slow': '1' });
      await browser('/api/v1/boards/' + ids.privateBoard, 'PATCH', { name: 'Visible board update' }, ownerCookie);
      await dispatch();
      update(await source.next(), boardUri);
      update(await other.next(), boardUri);
      assert.equal(await slow.next(), null);
      await drainCommitted(source, boardUri, ids.privateBoard);
      await drainCommitted(other, boardUri, ids.privateBoard);
      assert.equal(slowWrites, 1);

      const logout = await call('/api/v1/session', { method: 'DELETE', cookies: viewer.cookies,
        headers: { Origin: origin, 'X-CSRF-Token': viewer.csrf } });
      assert.equal(logout.status, 204, logout.text);
      assert.deepEqual(await source.next(true), { heartbeat: true });
      assert.deepEqual(await other.next(true), { heartbeat: true });
      const freshCsrf = await viewer.login();
      const revoked = await call('/api/v1/me/connections/' + viewerId, { method: 'DELETE', cookies: viewer.cookies,
        headers: { Origin: origin, 'X-CSRF-Token': freshCsrf } });
      assert.equal(revoked.status, 204, revoked.text);
      assert.equal(await source.next(), null);
      assert.deepEqual(await other.next(true), { heartbeat: true });

      const waiting = Promise.withResolvers();
      const resume = Promise.withResolvers();
      beforePublish = (actor) => {
        if (actor.grantId === otherId) {
          beforePublish = undefined;
          beforeProof = async (candidate) => {
            if (candidate.grantId !== otherId) return;
            beforeProof = undefined;
            waiting.resolve();
            await resume.promise;
          };
        }
      };
      await browser('/api/v1/boards/' + ids.privateBoard, 'PATCH', { name: 'Queued for removed viewer' }, ownerCookie, 2);
      await dispatch();
      await waiting.promise;
      try {
        const member = await f.db.collection('boardMembers').findOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.viewer });
        await f.gate.runCommand(async () => {
          await f.db.collection('boardMembers').deleteOne({ _id: member._id });
          await f.streams.revalidateBoards(f.db, f.generationId, new Set([ids.privateBoard]));
        });
        await f.gate.runCommand(() => f.db.collection('boardMembers').insertOne(member));
      } finally { resume.resolve(); }
      assert.equal(await other.next(), null);
      const reconnected = await watch(otherToken, [boardUri]);
      assert.deepEqual(await reconnected.next(true), { heartbeat: true });
      reconnected.close();

      const limited = [];
      for (let i = 0; i < 4; i += 1) limited.push(await watch(otherToken, [boardUri]));
      assert.equal((await collectHttps(await listen(otherToken, notifications(boardUri)))).status, 429);
      for (const watcher of limited) watcher.close();
      await delay(50);

      const idleGrant = await consentReader(call, origin, viewer.cookies);
      const idle = await grantFor(ids.viewer, 3);
      await f.db.collection('oauthArtifacts').updateOne({ ...f.scope, providerGrantId: idle.providerGrantId, kind: 'AccessToken' }, {
        $set: { expiresAt: new Date(Date.now() + 700) },
      });
      const expiring = await watch(activeToken(idleGrant), [boardUri]);
      const heartbeatWaiting = Promise.withResolvers();
      const finishHeartbeat = Promise.withResolvers();
      beforeProof = async (actor) => {
        if (actor.grantId === idle.id) {
          beforeProof = undefined;
          heartbeatWaiting.resolve();
          await finishHeartbeat.promise;
        }
      };
      await heartbeatWaiting.promise;
      try { assert.equal(await expiring.next(), null); }
      finally { finishHeartbeat.resolve(); }

      // The admitted id is large enough that its SDK ACK and twice-stamped final exceed 4 KiB.
      destination.close();
      const longId = 'x'.repeat(4094);
      const long = await watch(adminToken, [destinationUri], longId);
      const held = Promise.withResolvers();
      const release = Promise.withResolvers();
      const adminId = (await grantFor(ids.admin, 0)).id;
      beforeProof = async (actor) => {
        if (actor.grantId === adminId) {
          beforeProof = undefined;
          held.resolve();
          await release.promise;
        }
      };
      await held.promise;
      const closing = f.closeMcp();
      try { await delay(20); }
      finally { release.resolve(); }
      const final = await long.next();
      assert.equal(final?.id, longId);
      assert.equal(final.result.resultType, 'complete');
      assert.equal(final.result._meta[subscriptionId], longId);
      assert.equal(await long.next(), null);
      await closing;
    } finally {
      ServerResponse.prototype.write = nativeWrite;
      await sdk?.close();
      for (const watcher of streams) watcher.close();
      await tls.close();
    }
  }));
