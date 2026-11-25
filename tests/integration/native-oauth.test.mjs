import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Secret, TOTP } from 'otpauth';
import { defaultPreferences } from '../../apps/backend/dist/application/auth/accounts.js';
import { createMfaManagement } from '../../apps/backend/dist/application/auth/mfa-management.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { createOAuthClientRegistry } from '../../apps/backend/dist/application/oauth/clients.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { createBoardEventCursors } from '../../apps/backend/dist/application/board-events/cursor.js';
import { createReadMcpSurface } from '../../apps/backend/dist/application/mcp/read-surface.js';
import { mcpMutationCatalog } from '../../apps/backend/dist/application/mcp/mutation-catalog.js';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { buildApp } from '../../apps/backend/dist/build-app.js';
import { markProxyRequest } from '../../apps/backend/dist/native/http-boundary.js';
import { createNativeOAuthRuntime } from '../../apps/backend/dist/native/oauth-routes.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { publishSyntheticMigration } from '../support/migration-activation-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';

const origin = 'https://planner.example.test';
const hostname = new URL(origin).hostname;
const proxyToken = 'a'.repeat(64);
const resource = origin + '/mcp';
const clientId = 'synthetic-oauth-client';
const redirect = 'https://connector.example.test/callback';
const client = { client_id: clientId, client_name: 'Synthetic connector', redirect_uris: [redirect] };
const verifier = randomBytes(32).toString('base64url');
const dynamic = [
  { id: 'https://chatgpt.com/oauth/codex/client.json', redirects: ['http://127.0.0.1/callback', 'http://localhost/callback'],
    callback: 'http://127.0.0.1:49152/callback' },
  { id: 'https://claude.ai/oauth/claude-code-client-metadata', redirects: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    callback: 'http://localhost:49153/callback' },
  { id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', redirects: ['https://claude.ai/api/mcp/auth_callback'],
    callback: 'https://claude.ai/api/mcp/auth_callback' },
];
const challenge = createHash('sha256').update(verifier).digest('base64url');
const identifier = 'admin@example.test';
const password = 'Synthetic MFA passphrase';
const json = 'application/json';
const form = 'application/x-www-form-urlencoded';

function cookies() {
  const values = new Map();
  return {
    headers() { return { Cookie: [...values].map(([key, value]) => key + '=' + value).join('; ') }; },
    read(headers) {
      for (const entry of headers['set-cookie'] ?? []) {
        const [pair] = entry.split(';');
        const index = pair.indexOf('=');
        if (!pair.slice(index + 1)) values.delete(pair.slice(0, index));
        else values.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
  };
}

async function serve(app, fixture) {
  const { directory } = fixture;
  const key = join(directory, 'tls-key');
  const cert = join(directory, 'tls-cert');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
    '-subj', '/CN=' + hostname, '-addext', 'subjectAltName=DNS:' + hostname, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const certificate = await readFile(cert);
  await app.ready();
  const server = createServer({ key: await readFile(key), cert: certificate }, (incoming, outgoing) => {
    if (incoming.headers['x-test-proxy'] !== 'unmarked') markProxyRequest(incoming);
    incoming.headers['x-forwarded-host'] = hostname;
    incoming.headers['x-forwarded-proto'] = 'https';
    incoming.headers['x-forwarded-for'] = '192.0.2.17';
    incoming.headers['x-planner-proxy-token'] = proxyToken;
    app.routing(incoming, outgoing);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    call(path, { method = 'GET', body, type, headers, jar } = {}) {
      return new Promise((resolve, reject) => {
        const encoded = type === json ? JSON.stringify(body) : type === form ? new URLSearchParams(body).toString() : undefined;
        const req = request({ hostname: '127.0.0.1', servername: hostname, ca: certificate, port: server.address().port, path,
          method, headers: { Host: hostname, ...(encoded !== undefined && { 'Content-Type': type,
            'Content-Length': Buffer.byteLength(encoded) }), ...jar?.headers(), ...headers } }, async (response) => {
          try {
            const parts = [];
            for await (const chunk of response) parts.push(chunk);
            const text = Buffer.concat(parts).toString();
            jar?.read(response.headers);
            const parsed = text && response.headers['content-type']?.includes('json') ? JSON.parse(text) : null;
            resolve({ status: response.statusCode, headers: response.headers, text, json: parsed });
          } catch (error) { reject(error); }
        });
        req.setTimeout(4000, () => req.destroy(new Error('The OAuth HTTPS fixture did not respond.')));
        req.once('error', reject).end(encoded);
      });
    },
    close: async () => { await new Promise((resolve) => server.close(resolve)); await app.close(); },
  };
}

test('native OAuth binds protected discovery, browser MFA and consent to one resource and one code exchange',
  { timeout: 75_000 }, async () => withFixtureMongo(async (fixture) => {
    const { db, directory } = fixture;
    const generationId = randomUUID();
    const installationId = randomUUID();
    const actorId = randomUUID();
    const key = createSecretKey(randomBytes(32));
    const hasher = createPasswordHasher();
    let time = new Date(Date.now() - 30_000);
    const now = () => time;
    const writer = join(directory, 'writer');
    await mkdir(writer);
    await chmod(writer, 0o750);
    const owner = { uid: process.getuid(), gid: process.getgid() };
    const gate = new CommandGate(acquireWriterDirectory(writer, owner, owner));
    await db.collection('installation').insertOne({ _id: 'installation', installationId, schemaVersion: 0,
      activeGenerationId: generationId, setup: { mode: 'fresh', pendingAction: 'complete', enrollmentGenerationId: null } });
    await db.collection('users').insertOne({ _id: workspaceKey(generationId, actorId), id: actorId, generationId, revision: 1,
      name: 'Synthetic operator', email: identifier, normalizedEmail: identifier, username: null, normalizedUsername: null,
      role: 'admin', disabledAt: null, createdAt: time, preferences: defaultPreferences, requiresMfaEnrollment: false,
      localAuth: { passwordVerifier: await hasher.encode(password), credentialsVersion: 1, mfa: 'none' } });
    const memberId = randomUUID();
    const memberEmail = 'member@example.test';
    const adminRecord = await db.collection('users').findOne({ _id: workspaceKey(generationId, actorId) });
    await db.collection('users').insertOne({ ...adminRecord, _id: workspaceKey(generationId, memberId), id: memberId,
      name: 'Synthetic member', email: memberEmail, normalizedEmail: memberEmail, role: 'boardUser' });
    await migrateStorageSchema(db, installationId);
    await gate.recover(() => {});
    const sessions = createBrowserSessions(db, installationId, gate, hasher, now, key);
    const manage = createMfaManagement(db, installationId, gate, key, hasher, now);
    const first = await sessions.login({ identifier, password });
    const enrolled = await manage.begin({ sessionToken: first.token });
    const totp = new TOTP({ secret: Secret.fromBase32(enrolled.secret), issuer: 'Planner', digits: 6, period: 30, algorithm: 'SHA1' });
    const code = () => totp.generate({ timestamp: now().getTime() });
    const factor = await manage.confirm({ enrollmentId: enrolled.enrollmentId, sessionToken: first.token }, code());
    time = new Date(time.getTime() + 30_000);
    let access = { kind: 'ready' };
    let privateAnswer = false;
    const metadataReads = [];
    const revoked = [];
    const docs = new Map(dynamic.map(({ id, redirects }) => [id, { client_id: id, redirect_uris: redirects,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }]));
    const transport = {
      async resolve(hostname) {
        assert.ok(['chatgpt.com', 'claude.ai'].includes(hostname));
        return [privateAnswer ? '127.0.0.1' : '93.184.215.14'];
      },
      async read(url, address) {
        assert.equal(address, '93.184.215.14');
        metadataReads.push(url.href);
        return docs.get(url.href);
      },
    };
    let beforeMcpCommand;
    const app = (clients = [client]) => {
      const oauth = createNativeOAuthRuntime(origin, installationId, gate, key, (run) => run(db), clients,
        createOAuthClientRegistry(clients, transport), (grant) => { revoked.push(grant); });
      const { withCommandDatabase } = oauth;
      oauth.withCommandDatabase = (operation) => {
        beforeMcpCommand?.();
        return withCommandDatabase(operation);
      };
      return buildApp({ native: { origin, proxyToken, readAccess: async () => access, auth: { ...sessions, confirm: async () => false,
        mfa: { manage, verify: (input) => sessions.verifyMfa(input) } }, oauth,
        mcp: createReadMcpSurface(origin, createBoardEventCursors(key), true),
        mcpWrites: { store: {}, decode: async () => assert.fail('Unexpected media decode') },
      } });
    };
    let server = await serve(app(), fixture);
    const call = (path, options) => server.call(path, options);
    const post = (path, body, jar, type = json, headers = { Origin: origin }) => call(path, { method: 'POST', body, type, jar, headers });
    async function withMcpSdk(version, accessToken, operation) {
      const sdk = new Client({ name: 'Planner OAuth fixture', version: '1' }, {
        supportedProtocolVersions: [version],
        versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' },
      });
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => accessToken },
        async fetch(input, init) {
          const outgoing = new Request(input, init);
          const url = new URL(outgoing.url);
          assert.equal(url.origin, origin);
          const response = await call(url.pathname + url.search, {
            method: outgoing.method, headers: Object.fromEntries(outgoing.headers),
            ...(outgoing.body && { type: json, body: await outgoing.json() }),
          });
          return new Response(response.text || null, { status: response.status, headers: response.headers });
        },
      });
      try {
        await sdk.connect(transport, { timeout: 5000 });
        return await operation(sdk);
      } finally { await sdk.close(); }
    }
    const probeMcp = (headers = {}, path = '/mcp') => post(path, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'OAuth fixture', version: '1' },
      },
    }, undefined, json, { Accept: 'application/json, text/event-stream', ...headers });
    const requestCode = (overrides = {}) => '/oauth/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'synthetic-state', resource,
      scope: 'planner:read planner:write', code_challenge_method: 'S256', code_challenge: challenge, ...overrides,
    });
    const follow = (response, jar) => call(new URL(response.headers.location, origin).pathname, { jar });
    const consent = (path, input, jar, headers) => post(path, input, jar, form, headers);
    const token = (authorizationCode, overrides = {}) => post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
      code: authorizationCode, code_verifier: verifier, redirect_uri: redirect, resource, ...overrides }, undefined, form, {});
    const refresh = (refreshToken, overrides = {}) => post('/oauth/token', {
      grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, ...overrides,
    }, undefined, form, {});
    const jar = cookies();
    async function interaction(overrides = {}) {
      const requested = await call(requestCode(overrides), { jar });
      assert.equal(requested.status, 303, requested.text);
      assert.match(requested.headers.location, /^\/oauth\/interaction\/[A-Za-z0-9_-]+$/u);
      return requested.headers.location;
    }
    const csrfFrom = (response) => {
      assert.equal(response.status, 200, response.text);
      return /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(response.text)?.[1];
    };

    async function approve(path, write = true, offline = false, callbackUrl = redirect) {
      const accepted = await consent(path, { csrf: csrfFrom(await call(path, { jar })), decision: 'allow',
        ...(write && { write: 'yes' }), ...(offline && { offline: 'yes' }) }, jar);
      assert.equal(accepted.status, 303, accepted.text);
      const callback = await follow(accepted, jar);
      const location = new URL(callback.headers.location);
      assert.equal(location.origin + location.pathname, callbackUrl);
      const code = location.searchParams.get('code');
      assert.ok(code);
      return code;
    }

    try {
      const discovery = await call('/.well-known/oauth-protected-resource/mcp', { headers: { Forwarded: 'host=attacker.invalid' } });
      assert.equal(discovery.status, 200);
      assert.deepEqual(discovery.json, { resource, authorization_servers: [origin], scopes_supported: ['planner:read', 'planner:write'],
        bearer_methods_supported: ['header'] });
      assert.equal((await call('/.well-known/oauth-protected-resource/mcp', { headers: { 'x-test-proxy': 'unmarked' } })).status, 403);
      const unauthorized = await probeMcp();
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers['www-authenticate'], `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="planner:read"`);
      const metadata = (await call('/.well-known/oauth-authorization-server')).json;
      assert.deepEqual([metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri],
        [origin, origin + '/oauth/authorize', origin + '/oauth/token', origin + '/oauth/jwks']);
      assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
      const publicKeys = (await call('/oauth/jwks')).json;
      assert.equal(publicKeys.keys.length, 1);
      assert.match(publicKeys.keys[0].kid, /^[A-Za-z0-9_-]+$/u);
      for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) assert.equal(publicKeys.keys[0][field], undefined);
      for (const settings of [{ resource: origin + '/wrong' }, { redirect_uri: redirect + '?wrong=1' },
        { code_challenge_method: 'plain' }, { code_challenge: '' }, { client_id: 'unregistered' }, { scope: 'openid planner:read' }]) {
        const rejected = await call(requestCode(settings));
        assert.ok(rejected.status < 500 && !rejected.headers.location?.startsWith('/oauth/interaction/'),
          `Unexpected authorization response ${rejected.status} ${rejected.headers.location}.`);
      }

      const path = await interaction();
      const unauthenticated = await call(path, { jar });
      assert.equal(unauthenticated.status, 302);
      assert.equal(new URL(unauthenticated.headers.location, origin).searchParams.get('returnTo'), path);
      const begin = await post('/api/v1/session/login', { identifier, password }, jar);
      assert.equal(begin.json.status, 'challenge-required');
      const proved = await post('/api/v1/session/verify-mfa', { challengeId: begin.json.challengeId, totpCode: code(), rememberDevice: true }, jar);
      assert.equal(proved.json.status, 'authenticated');
      const initialBrowser = jar.headers();
      const allow = csrfFrom(await call(path, { jar }));
      assert.ok(allow);
      assert.equal((await consent(path, { csrf: allow, decision: 'allow' }, jar, { Origin: 'https://wrong.test' })).status, 403);
      assert.equal((await consent(path, { csrf: 'a'.repeat(43), decision: 'allow' }, jar)).status, 403);
      const decision = await consent(path, { csrf: allow, decision: 'allow' }, jar);
      assert.equal(decision.status, 303, decision.text);
      assert.equal((await consent(path, { csrf: allow, decision: 'allow' }, jar)).status, 403);
      const callback = await follow(decision, jar);
      assert.equal(callback.status, 303, callback.text);
      const location = new URL(callback.headers.location);
      assert.equal(location.origin + location.pathname, redirect);
      assert.equal(location.searchParams.get('iss'), origin);
      assert.equal(location.searchParams.get('state'), 'synthetic-state');
      const authorizationCode = location.searchParams.get('code');
      assert.ok(authorizationCode);
      for (const overrides of [{ code_verifier: 'x'.repeat(43) }, { redirect_uri: redirect + '?wrong=1' }]) {
        assert.equal((await token(authorizationCode, overrides)).status, 400);
      }
      const omittedRedirect = await post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
        code: authorizationCode, code_verifier: verifier, resource }, undefined, form, {});
      assert.equal(omittedRedirect.status, 400);
      assert.equal(omittedRedirect.json.error, 'invalid_request');
      assert.equal((await token(authorizationCode, { client_id: 'unregistered' })).status, 401);
      const swaps = await Promise.all([token(authorizationCode), token(authorizationCode)]);
      const success = swaps.find(({ status }) => status === 200);
      assert.ok(success, JSON.stringify(swaps.map(({ status, json: data }) => ({ status, data }))));
      assert.equal(swaps.filter(({ status }) => status === 200).length, 1);
      assert.equal(success.json.expires_in, 900);
      assert.equal(success.json.scope, 'planner:read');
      assert.match(success.json.access_token, /^[A-Za-z0-9_-]+$/u);
      assert.equal(success.json.refresh_token, undefined);
      assert.equal(success.json.id_token, undefined);

      const connections = db.collection('oauthConnections');
      const readGrants = { generationId, userId: actorId, clientId, scope: 'planner:read' };
      const previous = await connections.find(readGrants).map(({ id }) => id).toArray();
      const inactiveBrowserToken = await token(await approve(await interaction(), false));
      assert.equal(inactiveBrowserToken.status, 200);
      const firstConnection = await connections.findOne({ ...readGrants, id: { $nin: previous } });
      assert.ok(firstConnection);

      const canceledPath = await interaction();
      const canceled = await consent(canceledPath, { csrf: csrfFrom(await call(canceledPath, { jar })), decision: 'cancel' }, jar);
      assert.equal(canceled.status, 303);
      assert.equal(new URL((await follow(canceled, jar)).headers.location).searchParams.get('error'), 'access_denied');

      const trusted = await post('/api/v1/session/login', { identifier, password }, jar);
      assert.equal(trusted.json.status, 'authenticated');
      const next = await interaction();
      assert.equal((await call(next, { jar })).status, 302);
      const fresh = await post('/api/v1/session/login', { identifier, password, requireMfaChallenge: true }, jar);
      assert.equal(fresh.json.status, 'challenge-required');
      const consumed = await post('/api/v1/session/verify-mfa', { challengeId: fresh.json.challengeId, recoveryCode: factor.recoveryCodes[0] }, jar);
      assert.equal(consumed.json.status, 'authenticated');
      const secondCode = await approve(next);
      const full = await token(secondCode);
      assert.equal(full.status, 200);
      assert.deepEqual(full.json.scope.split(' ').sort(), ['planner:read', 'planner:write']);
      const bearer = { Authorization: 'Bearer ' + full.json.access_token };
      assert.equal((await probeMcp(bearer)).status, 200);
      assert.equal((await probeMcp({}, '/mcp?access_token=' + full.json.access_token)).status, 401);

      let previousNames;
      for (const version of ['2025-11-25', '2026-07-28']) {
        await withMcpSdk(version, full.json.access_token, async (sdk) => {
          const { tools } = await sdk.listTools();
          const names = tools.map(({ name }) => name);
          assert.equal(new Set(names).size, 85);
          assert.deepEqual(names.slice(-64), mcpMutationCatalog.map(({ name }) => name));
          if (previousNames) assert.deepEqual(names, previousNames);
          previousNames = names;
          const task = tools.find(({ name }) => name === 'task_create');
          assert.equal(task.inputSchema.type, 'object');
          assert.equal(task.inputSchema.anyOf.length, 2);
          assert.ok(task.inputSchema.anyOf.every(({ required }) => required.includes('idempotencyKey')));
        });
      }
      const boardKey = randomUUID();
      let boardArguments;
      let boardReceipt;
      await withMcpSdk('2026-07-28', full.json.access_token, async (sdk) => {
        const run = (name, args, idempotencyKey = randomUUID()) => sdk.callTool({ name,
          arguments: { ...args, idempotencyKey } });
        const project = (await run('project_create', { name: 'MCP fixture project', type: 'shared' })).structuredContent.data;
        const boardArgs = { id: project.id, expectedRevision: 1, name: 'MCP fixture board' };
        boardArguments = { ...boardArgs, idempotencyKey: boardKey };
        const [created, replay] = await Promise.all([run('board_create', boardArgs, boardKey), run('board_create', boardArgs, boardKey)]);
        assert.deepEqual(created, replay);
        boardReceipt = created;
        const board = created.structuredContent.data.board;
        const clash = await run('board_create', { ...boardArgs, name: 'Changed payload' }, boardKey);
        assert.equal(JSON.parse(clash.content[0].text).code, 'IDEMPOTENCY_CONFLICT');
        const list = (await run('list_create', { id: board.id, expectedRevision: board.revision,
          name: 'MCP fixture list', kind: 'active' })).structuredContent.data.list;
        const card = (await run('card_create', { id: list.id, expectedRevision: list.revision,
          name: 'MCP fixture card' })).structuredContent.data.card;
        assert.equal(card.name, 'MCP fixture card');
        const group = await run('field_create_group', { id: board.id, expectedRevision: board.revision + 1,
          scopeType: 'board', name: 'MCP fixture field group' });
        assert.ok(group.structuredContent, group.content[0].text);
        const audit = await db.collection('auditEntries').findOne({ generationId, action: 'boards.create' });
        assert.deepEqual([audit.actorId, audit.origin, audit.clientId], [actorId, 'mcp', 'registered:' + clientId]);

        const queuedKey = randomUUID();
        const changeRole = (role) => db.collection('users').updateOne({ generationId, id: actorId }, { $set: { role } });
        let queuedChange;
        beforeMcpCommand = () => {
          beforeMcpCommand = undefined;
          queuedChange = gate.runCommand(() => changeRole('boardUser'));
        };
        const forbidden = await run('project_create', { name: 'Former role', type: 'shared' }, queuedKey);
        await queuedChange;
        assert.equal(JSON.parse(forbidden.content[0].text).code, 'FORBIDDEN');
        assert.equal(await db.collection('commands').countDocuments({ generationId, idempotencyKey: queuedKey }), 0);
        await gate.runCommand(() => changeRole('admin'));
      });
      const persistent = { scope: 'planner:read planner:write offline_access' };
      const rejectedOffline = await token(await approve(await interaction(persistent), false));
      assert.equal(rejectedOffline.status, 200);
      assert.equal(rejectedOffline.json.refresh_token, undefined);
      const family = await token(await approve(await interaction(persistent), true, true));
      assert.equal(family.status, 200, family.text);
      assert.match(family.json.refresh_token, /^[A-Za-z0-9_-]+$/u);
      const rotated = await refresh(family.json.refresh_token, { scope: 'planner:read', resource });
      assert.equal(rotated.status, 200, rotated.text);
      assert.equal(rotated.json.scope, 'planner:read');
      assert.notEqual(rotated.json.refresh_token, family.json.refresh_token);
      const scoped = { Authorization: 'Bearer ' + rotated.json.access_token };
      const insufficient = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'card_update', arguments: { id: randomUUID() } } }, undefined, json, {
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...scoped,
      });
      assert.equal(insufficient.status, 403);
      assert.match(insufficient.headers['www-authenticate'], /insufficient_scope/u);
      const broadened = await refresh(rotated.json.refresh_token, { scope: 'planner:read planner:write' });
      assert.equal(broadened.status, 400);
      assert.equal(broadened.json.error, 'invalid_scope');
      const wrongAudience = await refresh(family.json.refresh_token, { resource: origin + '/not-mcp' });
      assert.equal(wrongAudience.status, 400);
      assert.equal(wrongAudience.json.error, 'invalid_target');
      assert.equal((await probeMcp(scoped)).status, 200);
      const replayed = await refresh(family.json.refresh_token);
      assert.equal(replayed.status, 400);
      assert.equal(replayed.json.error, 'invalid_grant');
      assert.equal((await probeMcp(scoped)).status, 401);
      assert.equal((await probeMcp(bearer)).status, 200);

      privateAnswer = true;
      assert.equal((await call(requestCode({ client_id: dynamic[0].id, redirect_uri: dynamic[0].callback }))).status, 400);
      assert.deepEqual(metadataReads, []);
      privateAnswer = false;
      const expected = docs.get(dynamic[0].id);
      docs.set(dynamic[0].id, { ...expected, redirect_uris: ['https://unrelated.example.test/callback'] });
      assert.equal((await call(requestCode({ client_id: dynamic[0].id, redirect_uri: dynamic[0].callback }))).status, 400);
      docs.set(dynamic[0].id, expected);
      assert.equal((await call(requestCode({ client_id: dynamic[0].id, redirect_uri: 'http://localhost:49152/other' }))).status, 400);
      for (const profile of dynamic) {
        const input = { client_id: profile.id, redirect_uri: profile.callback };
        const pinnedCode = await approve(await interaction(input), profile === dynamic[0], false, profile.callback);
        const otherCallback = new URL(profile.callback);
        if (otherCallback.protocol === 'http:') otherCallback.port = '49154';
        else otherCallback.pathname += '-other';
        assert.equal((await token(pinnedCode, { ...input, redirect_uri: otherCallback.href })).status, 400);
        const admitted = await token(pinnedCode, input);
        assert.equal(admitted.status, 200, admitted.text);
        assert.equal((await probeMcp({ Authorization: 'Bearer ' + admitted.json.access_token })).status, 200);
        if (profile === dynamic[0]) {
          await withMcpSdk('2025-11-25', admitted.json.access_token, async (sdk) => {
            const replay = await sdk.callTool({ name: 'board_create', arguments: boardArguments });
            assert.deepEqual(replay.structuredContent, boardReceipt.structuredContent);
            assert.deepEqual(replay.content, boardReceipt.content);
            const first = await db.collection('auditEntries').findOne({ generationId, action: 'boards.create' });
            assert.equal(first.clientId, 'registered:' + clientId);
            assert.equal(await db.collection('auditEntries').countDocuments({ generationId, action: 'boards.create' }), 1);
          });
        }
      }
      assert.equal(metadataReads.length, dynamic.length + 1);
      const own = await call('/api/v1/me/connections', { jar });
      assert.equal(own.status, 200, own.text);
      assert.ok(own.json.connections.some(({ name }) => name === 'Codex'));
      const ownIds = own.json.connections.map(({ id }) => id);
      for (const value of [...dynamic.map(({ id, callback }) => [id, callback]).flat(), full.json.access_token]) {
        assert.equal(own.text.includes(value), false);
      }
      const memberCookies = cookies();
      const memberLogin = await post('/api/v1/session/login', { identifier: memberEmail, password }, memberCookies);
      assert.equal(memberLogin.status, 200);
      const unauthorizedDelete = await call('/api/v1/me/connections/' + ownIds[0], { method: 'DELETE', jar: memberCookies,
        headers: { Origin: origin, 'X-CSRF-Token': memberLogin.json.csrfToken } });
      assert.equal(unauthorizedDelete.status, 404);
      assert.deepEqual((await call('/api/v1/me/connections', { jar: memberCookies })).json, { connections: [], next: null });
      const browser = await call('/api/v1/session', { jar });
      const disconnect = (id, headers = { Origin: origin, 'X-CSRF-Token': browser.json.csrfToken }) =>
        call('/api/v1/me/connections/' + id, { method: 'DELETE', jar, headers });
      const codex = own.json.connections.find(({ name }) => name === 'Codex');
      assert.equal((await disconnect(codex.id, { Origin: origin })).status, 403);
      assert.equal((await disconnect(codex.id)).status, 204);
      assert.equal((await disconnect(codex.id)).status, 204);
      assert.ok(revoked.some(({ grantId }) => grantId === codex.id));
      assert.equal((await probeMcp(bearer)).status, 200);

      const race = await token(await approve(await interaction(persistent), false, true));
      assert.equal(race.status, 200);
      const raceBearer = { Authorization: 'Bearer ' + race.json.access_token };
      const wrongClient = await refresh(race.json.refresh_token, { client_id: dynamic[0].id });
      assert.equal(wrongClient.status, 400);
      assert.equal(wrongClient.json.error, 'invalid_grant');
      assert.equal((await probeMcp(raceBearer)).status, 200);
      const [left, right] = await Promise.all([refresh(race.json.refresh_token), refresh(race.json.refresh_token)]);
      assert.ok([left, right].every((item) => item.status === 200 || (item.status === 400 && item.json.error === 'invalid_grant')));
      assert.ok([left, right].some((item) => item.status === 400));
      for (const result of [left, right]) if (result.status === 200) {
        assert.equal((await probeMcp({ Authorization: 'Bearer ' + result.json.access_token })).status, 401);
      }
      assert.equal((await probeMcp(raceBearer)).status, 401);
      assert.equal((await probeMcp(bearer)).status, 200);

      const closingFamily = await token(await approve(await interaction(persistent), false, true));
      assert.equal(closingFamily.status, 200);
      const latest = await connections.findOne({ generationId, userId: actorId, clientId, offline: true, revokedAt: null },
        { sort: { issuedAt: -1 } });
      const accessTokens = db.collection('oauthArtifacts');
      const shortLived = await accessTokens.findOne({ generationId, kind: 'AccessToken', providerGrantId: latest.providerGrantId });
      await accessTokens.updateOne({ _id: shortLived._id }, { $set: { expiresAt: new Date(0) } });
      assert.equal((await probeMcp({ Authorization: 'Bearer ' + closingFamily.json.access_token })).status, 401);
      const refreshedBeforeDeadline = await refresh(closingFamily.json.refresh_token);
      assert.equal(refreshedBeforeDeadline.status, 200);
      assert.equal((await probeMcp({ Authorization: 'Bearer ' + refreshedBeforeDeadline.json.access_token })).status, 200);
      const familyRows = await db.collection('oauthArtifacts').find({ generationId, kind: 'RefreshToken', providerGrantId: latest.providerGrantId }).toArray();
      assert.equal(familyRows.length, 2);
      assert.ok(familyRows.every((row) => row.expiresAt.getTime() <= latest.expiresAt.getTime()));
      await connections.updateOne({ _id: latest._id }, { $set: { expiresAt: new Date(0) } });
      assert.equal((await refresh(refreshedBeforeDeadline.json.refresh_token)).json.error, 'invalid_grant');
      assert.equal((await probeMcp({ Authorization: 'Bearer ' + refreshedBeforeDeadline.json.access_token })).status, 401);

      const thirdCode = await approve(await interaction());
      const badResource = await token(thirdCode, { resource: origin + '/not-mcp' });
      assert.equal(badResource.status, 400);
      assert.equal(badResource.json.error, 'invalid_target');
      const codeRows = db.collection('oauthArtifacts');
      const beforeExpiry = new Set((await codeRows.find({ kind: 'AuthorizationCode' }).toArray()).map(({ _id }) => _id));
      const expiredCode = await approve(await interaction());
      const [toExpire, unexpected] = (await codeRows.find({ kind: 'AuthorizationCode' }).toArray())
        .filter(({ _id }) => !beforeExpiry.has(_id));
      assert.ok(toExpire);
      assert.equal(unexpected, undefined);
      assert.equal((await codeRows.updateOne({ _id: toExpire._id }, { $set: { expiresAt: new Date(0) } })).modifiedCount, 1);
      const expired = await token(expiredCode);
      assert.equal(expired.status, 400);
      assert.equal(expired.json.error, 'invalid_grant');
      const rows = await db.collection('oauthArtifacts').find().toArray();
      assert.ok(rows.every((row) => row.generationId === generationId && row._id === workspaceKey(generationId, row.id)));
      const raw = JSON.stringify(rows);
      for (const secret of [success.json.access_token, authorizationCode, secondCode, verifier, password]) assert.equal(raw.includes(secret), false);
      const ttl = (await db.collection('oauthArtifacts').indexes()).find(({ name }) => name === 'provider_expiry');
      assert.deepEqual(ttl.key, { expiresAt: 1 });
      assert.equal(ttl.expireAfterSeconds, 0);
      assert.equal(gate.ready, true);

      const beforeRestart = await token(await approve(await interaction(persistent), false, true));
      assert.equal(beforeRestart.status, 200);
      const pendingRestart = await interaction();
      await server.close();
      server = await serve(app(), fixture);
      assert.deepEqual((await call('/oauth/jwks')).json, publicKeys);
      assert.ok(csrfFrom(await call(pendingRestart, { jar })));
      assert.equal((await probeMcp(bearer)).status, 200);
      await withMcpSdk('2026-07-28', full.json.access_token, async (sdk) => {
        assert.deepEqual(await sdk.callTool({ name: 'board_create', arguments: boardArguments }), boardReceipt);
      });
      const afterRestart = await refresh(beforeRestart.json.refresh_token);
      assert.equal(afterRestart.status, 200);

      const codeBeforeLogout = await approve(pendingRestart);
      const currentBrowser = await call('/api/v1/session', { jar });
      assert.equal(currentBrowser.status, 200);
      const logout = await call('/api/v1/session', { method: 'DELETE', jar,
        headers: { Origin: origin, 'X-CSRF-Token': currentBrowser.json.csrfToken } });
      assert.equal(logout.status, 204);
      assert.equal((await call('/api/v1/session', { jar })).status, 401);
      assert.equal((await refresh(afterRestart.json.refresh_token)).status, 200);
      const loggedOutSwap = await token(codeBeforeLogout);
      assert.equal(loggedOutSwap.status, 400);
      assert.equal(loggedOutSwap.json.error, 'invalid_grant');
      assert.equal((await probeMcp(bearer)).status, 200);

      const readBearer = { Authorization: 'Bearer ' + inactiveBrowserToken.json.access_token };
      const sessionsCollection = db.collection('sessions');
      const firstSession = await sessionsCollection.findOne({ id: firstConnection.browserSessionId, generationId });
      assert.equal(firstSession.revokedAt, null);
      const older = (date) => new Date(date.getTime() - 3 * 60_000);
      await sessionsCollection.updateOne({ _id: firstSession._id }, { $set: {
        createdAt: older(firstSession.createdAt), lastActivityAt: older(firstSession.lastActivityAt),
        expiresAt: older(firstSession.expiresAt), factorVerifiedAt: older(firstSession.factorVerifiedAt),
      } });
      const users = db.collection('users');
      const actor = { _id: workspaceKey(generationId, actorId) };
      await users.updateOne(actor, { $set: { 'preferences.autoLogout': '2m' } });
      assert.equal((await call('/api/v1/session', { headers: initialBrowser })).status, 401);
      assert.equal((await probeMcp(readBearer)).status, 200);

      await server.close();
      server = await serve(app([]), fixture);
      assert.equal((await probeMcp(bearer)).status, 401);
      await server.close();
      server = await serve(app(), fixture);
      assert.equal((await probeMcp(bearer)).status, 200);

      // A token that passed transport admission must still match the credential epoch at commit.
      await withMcpSdk('2026-07-28', full.json.access_token, async (sdk) => {
        const idempotencyKey = randomUUID();
        let change;
        beforeMcpCommand = () => {
          beforeMcpCommand = undefined;
          change = gate.runCommand(() => users.updateOne(actor, { $inc: { 'localAuth.credentialsVersion': 1 } }));
        };
        const rejected = await sdk.callTool({ name: 'project_create',
          arguments: { name: 'Former credentials', type: 'shared', idempotencyKey } });
        await change;
        assert.equal(JSON.parse(rejected.content[0].text).code, 'UNAUTHENTICATED');
        assert.equal(await db.collection('commands').countDocuments({ generationId, idempotencyKey }), 0);
        await gate.runCommand(() => users.updateOne(actor, { $inc: { 'localAuth.credentialsVersion': -1 } }));
      });

      // Verify each durable condition independently of the revocation sweeps.
      const saved = await users.findOne(actor);
      for (const [field, changed, original] of [
        ['localAuth.credentialsVersion', saved.localAuth.credentialsVersion + 1, saved.localAuth.credentialsVersion],
        ['localAuth.factor.id', randomUUID(), saved.localAuth.factor.id],
        ['disabledAt', new Date(), null],
      ]) {
        await users.updateOne(actor, { $set: { [field]: changed } });
        assert.equal((await probeMcp(bearer)).status, 401);
        await users.updateOne(actor, { $set: { [field]: original } });
        assert.equal((await probeMcp(bearer)).status, 200);
      }

      await connections.updateOne({ _id: firstConnection._id }, { $set: { revokedAt: new Date() } });
      assert.equal((await probeMcp(readBearer)).status, 401);
      assert.equal((await probeMcp(bearer)).status, 200);
      const reauth = await post('/api/v1/session/login', { identifier, password, requireMfaChallenge: true }, jar);
      const verified = await post('/api/v1/session/verify-mfa', { challengeId: reauth.json.challengeId,
        recoveryCode: factor.recoveryCodes[1] }, jar);
      assert.equal(verified.status, 200);
      const disabled = await call('/api/v1/me/mfa', { method: 'DELETE', type: json, jar,
        headers: { Origin: origin, 'X-CSRF-Token': verified.json.csrfToken }, body: { password, recoveryCode: factor.recoveryCodes[2] } });
      assert.equal(disabled.status, 204);
      assert.equal((await probeMcp(bearer)).status, 401);
      assert.equal(await connections.countDocuments({ generationId, userId: actorId, revokedAt: null }), 0);

      access = { kind: 'enrollment', step: 'account-recovery' };
      assert.equal((await probeMcp()).status, 503);
      assert.equal((await call(requestCode())).status, 503);
      access = { kind: 'ready' };
      await publishSyntheticMigration(db, { installationId, generationId, actorId });
      assert.equal((await call(requestCode())).status, 503);
      assert.equal(gate.ready, true);
    } finally { await server.close(); await gate.closeAndDrain(); }
  }));
