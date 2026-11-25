import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MongoServerError } from 'mongodb';
import { Secret, TOTP } from 'otpauth';
import { relationshipReads, workspaceOperations } from '@planner/contracts';
import { readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { createOAuthStorage } from '../../apps/backend/dist/application/oauth/storage.js';
import { createReadMcpSurface } from '../../apps/backend/dist/application/mcp/read-surface.js';
import { createNativeOAuthRuntime } from '../../apps/backend/dist/native/oauth-routes.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { password } from '../support/account-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { client, consentReader, httpsCall, legacy, modern, rpcCall, sdkHttpsFetch } from '../support/mcp-https-fixture.mjs';
import { tlsBridge } from '../support/tls-bridge.mjs';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture } from '../support/workspace-access-fixture.mjs';

const json = 'application/json';

function readValue(reply) {
  assert.equal(reply.status, 200, reply.text);
  assert.ok(reply.value?.result && !reply.value.result.isError, reply.text);
  return reply.value.result;
}

function readFailure(reply, code) {
  assert.equal(reply.status, 200, reply.text);
  const data = reply.value?.result;
  assert.equal(data?.isError, true, reply.text);
  const error = JSON.parse(data.content[0].text);
  assert.equal(error.code, code, reply.text);
  return error;
}

function compareDto(actual, expected) {
  if (expected.page?.nextCursor) {
    assert.match(actual.page.nextCursor, /^v1\.[A-Za-z0-9_-]+$/u);
    assert.deepEqual({ ...actual, page: { ...actual.page, nextCursor: expected.page.nextCursor } }, expected);
  } else assert.deepEqual(actual, expected);
}

test('official modern and legacy MCP read catalogs match authorized REST DTOs over trusted HTTPS',
  { timeout: 90_000 }, () => withFixtureMongo(async (mongo) => {
    let f;
    let betweenAdmissionAndSnapshot;
    let duringSnapshot;
    let accessTime = Date.now();
    let time = Date.now() - 150_000;
    const tls = await tlsBridge(mongo.directory, async (origin) => {
      f = await makeWorkspaceAccessFixture(mongo, {
        browserOrigin: origin, clock: () => new Date(time),
        configureMcp({ db, installationId, gate, mfaKey, cursors }) {
          const mcp = createReadMcpSurface(origin, cursors);
          const runtime = createNativeOAuthRuntime(origin, installationId, gate, mfaKey, (operation) => operation(db), [client]);
          const liveRead = createOAuthStorage(installationId, gate, runtime.secrets, () => new Date(accessTime));
          const oauth = { ...runtime, storage: { ...runtime.storage,
            withAccessTokenRead: (token, operation) => liveRead.withRequest(db, () => liveRead.withAccessTokenRead(token, operation)),
          } };
          return {
            oauth,
            mcp: { ...mcp, register(server, actor, era) {
              mcp.register(server, { ...actor, async read(operation) {
                const effect = betweenAdmissionAndSnapshot;
                betweenAdmissionAndSnapshot = undefined;
                if (effect) await gate.runCommand(effect);
                const delivery = duringSnapshot;
                duringSnapshot = undefined;
                return actor.read((database, principal) => delivery ? delivery(database, principal, operation) : operation(database, principal));
              } }, era);
            } },
          };
        },
      });
      return { path: f.socketPath, close: f.close };
    });
    const call = (path, options) => httpsCall(tls, path, options);
    const origin = tls.origin;
    const card = { boardId: ids.privateBoard, cardId: ids.activeCard };
    try {
      const fixtureActors = {};
      for (const [which, id, key] of [
        ['owner', ids.privateOwner, 'private-owner'], ['viewer', ids.viewer, 'viewer'], ['admin', ids.admin, 'admin'],
      ]) {
        const initial = await f.login(id);
        const sessionToken = readSessionCookie(cookieOf(initial));
        assert.ok(sessionToken);
        const pending = await f.manage.begin({ sessionToken });
        const totp = new TOTP({ secret: Secret.fromBase32(pending.secret), issuer: 'Planner', digits: 6, period: 30, algorithm: 'SHA1' });
        await f.manage.confirm({ sessionToken, enrollmentId: pending.enrollmentId }, totp.generate({ timestamp: time }));
        time += 30_000;
        const cookies = new Map();
        const browser = (path, body) => call(path, { method: 'POST', cookies, body, headers: { Origin: origin } });
        const signin = await browser('/api/v1/session/login', { identifier: key + '@planner.invalid', password });
        assert.equal(signin.value.status, 'challenge-required', signin.text);
        const proved = await browser('/api/v1/session/verify-mfa', {
          challengeId: signin.value.challengeId, totpCode: totp.generate({ timestamp: time }),
        });
        assert.equal(proved.value.status, 'authenticated', proved.text);
        fixtureActors[which] = { id, cookies, token: (await consentReader(call, origin, cookies)).access_token };
      }

      const label = fixtureId(500);
      const note = fixtureId(502);
      const ownerNotification = fixtureId(504);
      const viewerNotification = fixtureId(505);
      const file = fixtureId(506);
      const unavailable = fixtureId(507);
      const digest = 'a'.repeat(64);
      await f.insert('labels', label, { boardId: ids.privateBoard, name: 'Logistics', color: 'berry-red', rank: '1' });
      await f.insert('cardLabels', fixtureId(501), { cardId: ids.activeCard, labelId: label });
      await f.insert('comments', note, { ...card, authorId: ids.firstEditor, text: 'Parcel café 边界 🙂' });
      await f.insert('activities', fixtureId(503), { ...card, kind: 'createCard', actorId: ids.firstEditor });
      await f.insert('notifications', ownerNotification, { ...card, recipientId: ids.privateOwner, actorId: ids.firstEditor,
        kind: 'commentCard', commentId: note, readAt: null });
      await f.insert('notifications', viewerNotification, { ...card, recipientId: ids.viewer, actorId: ids.firstEditor,
        kind: 'commentCard', commentId: note, readAt: null });
      await f.insert('attachments', file, { cardId: ids.activeCard, kind: 'file', name: 'Protected parcel', byteLength: 13,
        blobDigest: digest, availability: 'available', deletedAt: null });
      await f.insert('attachments', unavailable, { cardId: ids.activeCard, kind: 'file', name: 'Unavailable parcel', byteLength: 13,
        blobDigest: 'b'.repeat(64), availability: 'unavailable', deletedAt: null });
      await f.insert('blobs', fixtureId(510), { digest, byteLength: 13, lifecycleState: 'available', mimeType: 'application/octet-stream' });
      await f.insert('fieldGroups', fixtureId(508), { scopeType: 'project', scopeId: ids.privateProject,
        name: 'Parcel template', rank: '1', templateGroupId: null });
      for (let i = 0; i < 28; i += 1) {
        await f.insert('cards', fixtureId(600 + i), { boardId: ids.privateBoard, listId: ids.privateActiveList,
          kind: 'board', type: 'project', name: 'Private fixture page ' + i, rank: String(10240 + i) });
        await f.insert('cards', fixtureId(520 + i), { boardId: ids.sharedBoard, listId: ids.sharedActiveList,
          kind: 'board', type: 'project', name: 'Hidden from private viewers ' + i, rank: String(10240 + i) });
      }

      const named = [
        ['project_list', workspaceOperations.projectsList, { favorite: false }],
        ['project_get', workspaceOperations.projectGet, { id: ids.privateProject }],
        ['board_list', workspaceOperations.boardsList, { id: ids.privateProject }],
        ['board_get', workspaceOperations.boardGet, { id: ids.privateBoard }],
        ['board_workspace', workspaceOperations.boardWorkspace, { id: ids.privateBoard }],
        ['board_cards', workspaceOperations.boardCards, { id: ids.privateBoard, labelsAny: [label, label], unassigned: false, q: 'Dispatch', limit: 1 }],
        ['card_get', workspaceOperations.cardGet, { id: ids.activeCard, boardId: ids.privateBoard }],
        ['label_list', workspaceOperations.boardLabels, { id: ids.privateBoard }],
        ['checklist_list', workspaceOperations.cardChecklists, { id: ids.activeCard }],
        ['comment_list', workspaceOperations.cardComments, { id: ids.activeCard }],
        ['activity_board', workspaceOperations.boardActivity, { id: ids.privateBoard }],
        ['activity_card', workspaceOperations.cardActivity, { id: ids.activeCard }],
        ['notification_list', workspaceOperations.notificationsList, { unread: true }],
        ['board_transfer_destinations', relationshipReads['boards.transferDestinations'], { id: ids.privateBoard }],
        ['field_template_options', relationshipReads['fields.templateOptions'], { id: ids.privateBoard }],
        ['project_managers', relationshipReads['projects.managers'], { id: ids.sharedProject }, 'admin'],
        ['project_manager_candidates', relationshipReads['projects.managerCandidates'], { id: ids.sharedProject }, 'admin'],
        ['board_members', relationshipReads['boards.members'], { id: ids.privateBoard }],
        ['board_filter_members', relationshipReads['boards.filterMembers'], { id: ids.privateBoard }],
        ['board_mention_members', relationshipReads['boards.mentionMembers'], { id: ids.privateBoard }],
        ['board_member_candidates', relationshipReads['boards.memberCandidates'], { id: ids.privateBoard }],
      ];
      const owner = fixtureActors.owner;
      const viewer = fixtureActors.viewer;
      const admin = fixtureActors.admin;
      const discovery = readValue(await rpcCall(call, modern, 'server/discover'));
      assert.deepEqual(discovery.capabilities, {
        tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false },
      });
      const initialized = readValue(await rpcCall(call, legacy, 'initialize',
        { protocolVersion: legacy, capabilities: {}, clientInfo: { name: 'Synthetic reader', version: '1' } }, owner.token));
      assert.deepEqual(initialized.capabilities, discovery.capabilities);

      for (const era of [modern, legacy]) {
        const sdk = new Client({ name: 'Planner HTTPS fixture', version: '1' }, {
          supportedProtocolVersions: [era], versionNegotiation: { mode: era === modern ? { pin: modern } : 'legacy' },
        });
        const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
          authProvider: { token: async () => owner.token },
          fetch: (input, init) => sdkHttpsFetch(tls, input, init),
        });
        try {
          await sdk.connect(transport, { timeout: 5000 });
          const list = await sdk.listTools();
          assert.deepEqual(list.tools.map(({ name }) => name), named.map(([name]) => name));
          const board = await sdk.callTool({ name: 'board_get', arguments: { id: ids.privateBoard } });
          assert.equal(board.structuredContent.data.id, ids.privateBoard);
          const resource = await sdk.readResource({ uri: 'planner://boards/' + ids.privateBoard });
          assert.deepEqual(JSON.parse(resource.contents[0].text), board.structuredContent);
        } finally { await sdk.close(); }
        const rpc = (method, params = {}, actor = owner) => rpcCall(call, era, method, params, actor.token);
        const read = (name, args, actor) => rpc('tools/call', { name, arguments: args }, actor);
        const catalog = [];
        let cursor;
        do {
          const listing = readValue(await rpc('tools/list', cursor ? { cursor } : {}));
          catalog.push(...listing.tools);
          cursor = listing.nextCursor;
          assert.ok(catalog.length <= named.length);
        } while (cursor);
        assert.deepEqual(catalog.map(({ name }) => name), named.map(([name]) => name));
        const firstPage = readValue(await rpc('tools/list'));
        assert.equal(firstPage.tools.length, 10);
        assert.equal((await rpc('tools/list', { cursor: firstPage.nextCursor }, viewer)).value.error.code, -32602);
        assert.equal((await rpc('resources/list', { cursor: firstPage.nextCursor })).value.error.code, -32602);
        const boardCardsSchema = catalog.find(({ name }) => name === 'board_cards').inputSchema;
        assert.equal(boardCardsSchema.additionalProperties, false);
        assert.equal(boardCardsSchema.properties.limit.type, 'integer');
        assert.equal(boardCardsSchema.properties.limit.default, 25);
        assert.equal(boardCardsSchema.properties.unassigned.type, 'boolean');
        assert.equal(boardCardsSchema.properties.labelsAny.type, 'array');
        assert.equal(boardCardsSchema.properties.labelsAny.maxItems, 50);

        for (const [name, descriptor, args, who = 'owner'] of named) {
          const { id, ...query } = args;
          const encoded = new URLSearchParams();
          for (const [key, value] of Object.entries(query)) {
            for (const member of Array.isArray(value) ? value : [value]) encoded.append(key, String(member));
          }
          const path = id ? descriptor.path.replace(':id', id) : descriptor.path;
          const actor = fixtureActors[who];
          const rest = await call(path + (encoded.size ? '?' + encoded : ''), { cookies: actor.cookies });
          assert.equal(rest.status, 200, name + ': ' + rest.text);
          const reply = readValue(await read(name, args, actor));
          compareDto(reply.structuredContent, rest.value);
          assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent, name);
          if (name === 'notification_list') assert.deepEqual(reply.structuredContent.data.map(({ id }) => id), [ownerNotification]);
          if (name === 'card_get') {
            assert.deepEqual(JSON.parse(reply.content[1].text).browserFiles, [
              { id: file, name: 'Protected parcel', browserUrl: origin + '/api/v1/attachments/' + file + '/download' },
            ]);
            assert.equal(JSON.stringify(reply).includes(digest), false);
          }
        }
        for (const raw of [{ limit: '1' }, { limit: 101 }, { unassigned: 'false' }, { labelsAny: label }, { unknown: true }]) {
          readFailure(await read('board_cards', { id: ids.privateBoard, ...raw }), 'INVALID_REQUEST');
        }
        const inaccessible = readFailure(await read('board_cards', { id: ids.sharedBoard, limit: 'bad' }, viewer), 'NOT_FOUND');
        assert.deepEqual(readFailure(await read('board_cards', { id: fixtureId(999), q: 'x'.repeat(300) }, viewer), 'NOT_FOUND'), inaccessible);
        readFailure(await read('field_template_options', { id: ids.privateBoard }, viewer), 'FORBIDDEN');
        const boardPage = readValue(await read('board_cards', { id: ids.privateBoard }));
        assert.equal(boardPage.structuredContent.data.length, 25);
        const page = boardPage.structuredContent.page.nextCursor;
        assert.ok(page);
        const nextRest = await call('/api/v1/boards/' + ids.privateBoard + '/cards?' + new URLSearchParams({ cursor: page }),
          { cookies: owner.cookies });
        compareDto(readValue(await read('board_cards', { id: ids.privateBoard, cursor: page })).structuredContent, nextRest.value);
        readFailure(await read('board_cards', { id: ids.privateBoard, cursor: page }, viewer), 'INVALID_CURSOR');
        const historical = readValue(await read('board_cards', { id: ids.privateBoard, context: 'archive' }, viewer)).structuredContent;
        const restHistory = await call('/api/v1/boards/' + ids.privateBoard + '/cards?context=archive', { cookies: viewer.cookies });
        compareDto(historical, restHistory.value);
        assert.deepEqual(historical.data.map(({ id }) => id), [ids.archivedStory]);

        const templates = readValue(await rpc('resources/templates/list'));
        assert.deepEqual(templates.resourceTemplates.map(({ uriTemplate, mimeType }) => [uriTemplate, mimeType]), [
          ['planner://boards/{id}', json], ['planner://cards/{id}', json],
        ]);
        const resources = [];
        cursor = undefined;
        do {
          const page = readValue(await rpc('resources/list', cursor ? { cursor } : {}, viewer));
          resources.push(...page.resources);
          cursor = page.nextCursor;
          assert.ok(resources.length <= 32);
        } while (cursor);
        assert.equal(resources.length, 32);
        assert.equal(resources[0].uri, 'planner://boards/' + ids.privateBoard);
        assert.equal(resources.every(({ mimeType, name }) => mimeType === json && !name.includes('Hidden from')), true);
        assert.equal(new Set(resources.map(({ uri }) => uri)).size, resources.length);
        const cardUri = 'planner://cards/' + ids.activeCard;
        const content = readValue(await rpc('resources/read', { uri: cardUri }, viewer)).contents[0];
        assert.equal(content.mimeType, json);
        assert.deepEqual(JSON.parse(content.text), (await call('/api/v1/cards/' + ids.activeCard, { cookies: viewer.cookies })).value);
        assert.equal((await rpc('resources/read', { uri: cardUri + '?extra=true' }, viewer)).value.error.code, -32602);
        const hiddenUri = 'planner://cards/' + ids.sharedTarget;
        assert.deepEqual((await rpc('resources/read', { uri: hiddenUri }, viewer)).value.error.data, { uri: hiddenUri });

        const promptList = readValue(await rpc('prompts/list'));
        assert.equal(promptList.prompts[1].arguments[1].name, 'filters');
        assert.deepEqual(promptList.prompts.map(({ name, arguments: args }) => [name, args[0].name, args[0].required]),
          [['board_status', 'boardId', true], ['board_triage', 'boardId', true]]);
        for (const [name, path] of [['board_status', 'workspace'], ['board_triage', 'cards']]) {
          const prompt = readValue(await rpc('prompts/get', { name, arguments: { boardId: ids.privateBoard } }, viewer));
          assert.equal(prompt.messages.length, 2);
          assert.match(prompt.messages[0].content.text, /^Summarize/u);
          compareDto(JSON.parse(prompt.messages[1].content.text),
            (await call('/api/v1/boards/' + ids.privateBoard + '/' + path, { cookies: viewer.cookies })).value);
          assert.equal((await rpc('prompts/get', { name, arguments: { boardId: ids.sharedBoard } }, viewer)).value.error.code, -32602);
        }
        const filtered = await rpc('prompts/get', { name: 'board_triage', arguments: {
          boardId: ids.privateBoard, filters: JSON.stringify({ context: 'archive', q: 'Dispatch', limit: 10 }),
        } }, viewer);
        compareDto(JSON.parse(readValue(filtered).messages[1].content.text),
          (await call('/api/v1/boards/' + ids.privateBoard + '/cards?context=archive&q=Dispatch&limit=10', { cookies: viewer.cookies })).value);
        const invalidTriage = (boardId) => rpc('prompts/get', { name: 'board_triage', arguments: { boardId, filters: '{' } }, viewer);
        assert.equal((await invalidTriage(ids.privateBoard)).value.error.message, 'Check the board triage filters.');
        assert.equal((await invalidTriage(ids.sharedBoard)).value.error.message, 'The workspace resource is unavailable.');
      }

      const record = (id) => ({ _id: workspaceKey(f.generationId, id) });
      const readModern = (name, args, actor = owner) => rpcCall(call, modern, 'tools/call', { name, arguments: args }, actor.token);
      const boardScope = { id: ids.privateBoard };
      duringSnapshot = (database, principal, operation) => operation({
        collection(name) {
          if (name === 'boards') return { aggregate: () => ({
            async *[Symbol.asyncIterator]() { throw new MongoServerError({ code: 50, message: 'synthetic query deadline' }); },
            async close() {},
          }) };
          return database.collection(name);
        },
      }, principal);
      const deadline = await rpcCall(call, modern, 'resources/list', {}, viewer.token);
      assert.equal(deadline.value.error.code, -32602);
      assert.doesNotMatch(deadline.text, /synthetic query deadline/u);
      assert.equal(f.gate.ready, true);
      readValue(await readModern('board_get', boardScope, viewer));

      const getCard = () => readModern('card_get', { id: ids.activeCard });
      const description = async (value) => mongo.db.collection('cards').updateOne(record(ids.activeCard), { $set: { description: value } });
      const large = '🧾'.repeat(16_384);
      await description('');
      const empty = readValue(await getCard());
      delete empty.resultType;
      delete empty._meta;
      const bodyBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8');
      const remaining = 64 * 1024 - bodyBytes;
      const exact = large.slice(0, Math.floor(remaining / 8) * 2) + 'x'.repeat(Math.floor((remaining % 8) / 2));
      await description(exact);
      assert.equal(readValue(await getCard()).structuredContent.data.description, exact);
      await description(exact + 'a');
      readFailure(await getCard(), 'RESULT_TOO_LARGE');
      await description('Synthetic dispatch');

      const snapshotTime = accessTime = Date.now();
      const proofExpiry = async (grantExpiry) => {
        const scope = { generationId: f.generationId, userId: ids.privateOwner };
        const collection = mongo.db.collection(grantExpiry ? 'oauthConnections' : 'oauthArtifacts');
        const match = grantExpiry ? scope : { ...scope, kind: 'AccessToken' };
        const saved = await collection.findOne(match);
        const expiresAt = new Date(accessTime + 30_000);
        await collection.updateOne(match, { $set: { expiresAt } });
        try {
          duringSnapshot = async (database, principal, operation) => {
            const materialized = await operation(database, principal);
            accessTime = expiresAt.getTime();
            return materialized;
          };
          readFailure(await readModern('board_get', boardScope), 'UNAUTHENTICATED');
        } finally {
          accessTime = snapshotTime;
          await collection.updateOne(match, { $set: { expiresAt: saved.expiresAt } });
        }
      };
      await proofExpiry(false);
      await proofExpiry(true);
      readValue(await readModern('board_get', boardScope));

      betweenAdmissionAndSnapshot = () => mongo.db.collection('users').updateOne(record(ids.admin), { $set: { role: 'boardUser' } });
      readFailure(await readModern('board_get', { id: ids.sharedBoard }, admin), 'NOT_FOUND');
      betweenAdmissionAndSnapshot = () => mongo.db.collection('oauthConnections').updateOne(
        { generationId: f.generationId, userId: ids.viewer }, { $set: { revokedAt: new Date() } });
      readFailure(await readModern('board_get', { id: ids.privateBoard }, viewer), 'UNAUTHENTICATED');
      betweenAdmissionAndSnapshot = () => mongo.db.collection('installation').updateOne(
        { _id: 'installation' }, { $set: { activeGenerationId: f.stagedGenerationId } });
      readFailure(await readModern('board_get', { id: ids.privateBoard }), 'UNAUTHENTICATED');
    } finally { await tls.close(); }
  }));
