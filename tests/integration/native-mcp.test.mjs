import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { buildApp } from '../../apps/backend/dist/build-app.js';
import { markProxyRequest } from '../../apps/backend/dist/native/http-boundary.js';

const origin = 'https://planner-mcp.example.test';
const authority = new URL(origin).host;
const modern = '2026-07-28';
const legacy = '2025-11-25';
const protocol = 'io.modelcontextprotocol/protocolVersion';
const capabilities = 'io.modelcontextprotocol/clientCapabilities';
const subscriptionId = 'io.modelcontextprotocol/subscriptionId';
const accept = 'application/json, text/event-stream';
const body = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
const modernBody = (method, params = {}, meta = {}) => body(method, { ...params, _meta: { [protocol]: modern, [capabilities]: {}, ...meta } });
const tokenA = 'mcp-fixture-actor-alpha';
const tokenB = 'mcp-fixture-actor-beta';
const tokenWrite = 'mcp-fixture-actor-writer';

async function serverFixture(t, app) {
  const temp = await mkdtemp(join(tmpdir(), 'planner-mcp-'));
  const key = join(temp, 'key.pem');
  const cert = join(temp, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
    '-subj', '/CN=' + authority, '-addext', 'subjectAltName=DNS:' + authority, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const ca = await readFile(cert);
  await app.ready();
  const server = createServer({ key: await readFile(key), cert: ca }, (incoming, outgoing) => {
    if (incoming.headers['x-fixture-unmarked'] !== '1') markProxyRequest(incoming);
    Object.assign(incoming.headers, { 'x-forwarded-host': authority, 'x-forwarded-proto': 'https',
      'x-forwarded-for': '192.0.2.22', 'x-planner-proxy-token': 'a'.repeat(64) });
    app.routing(incoming, outgoing);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await app.closeMcp?.();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });
  function open({ method = 'POST', payload, headers, token, chunked = false } = {}) {
    const encoded = typeof payload === 'string' ? payload : payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', servername: authority, port: server.address().port, ca, method, path: '/mcp',
        headers: { Host: authority, Accept: accept, ...(token && { Authorization: 'Bearer ' + token }),
          ...(encoded !== undefined && { 'Content-Type': 'application/json', ...(!chunked && { 'Content-Length': Buffer.byteLength(encoded) }) }),
          ...headers } }, resolve);
      outgoing.once('error', reject);
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('MCP fixture request timed out.')));
      outgoing.end(encoded);
    });
  }
  async function complete(options) {
    const response = await open(options);
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    return { status: response.statusCode, headers: response.headers, text,
      json: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null };
  }
  function options(payload, token, headers = {}) {
    return { payload, token, headers: { 'MCP-Protocol-Version': modern, 'Mcp-Method': payload.method, ...headers } };
  }
  return { open, complete, options };
}

async function* frames(response) {
  let pending = '';
  for await (const chunk of response) {
    pending += chunk.toString();
    for (;;) {
      const end = pending.indexOf('\n\n');
      if (end < 0) break;
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) yield JSON.parse(data.slice(6));
    }
  }
}

test('trusted HTTPS MCP negotiates 2025 stateless and 2026 per-request traffic, with scoped independent SSE exchanges',
  { timeout: 30000 }, async (t) => {
    const grants = new Map([
      [tokenA, { generationId: 'generation', userId: 'alpha', clientId: 'synthetic', grantId: 'a', scope: 'planner:read' }],
      [tokenB, { generationId: 'generation', userId: 'beta', clientId: 'synthetic', grantId: 'b', scope: 'planner:read' }],
      [tokenWrite, { generationId: 'generation', userId: 'writer', clientId: 'synthetic', grantId: 'c', scope: 'planner:read planner:write' }],
    ]);
    const bus = new InMemoryServerEventBus();
    const seen = new Set();
    let accessChecks = 0;
    const oauth = { origin, registry: { allowsId: (id) => id === 'synthetic' },
      request: (operation) => operation(), storage: { async accessToken(token) {
        accessChecks++;
        const grant = grants.get(token);
        return grant && { ...grant, audience: origin + '/mcp' };
      } } };
    const surface = {
      bus,
      capabilities: (era) => ({ tools: { listChanged: era === 'modern' },
        resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } }),
      register(server, actor, era) {
        seen.add(server);
        server.registerTool('fixture_actor', {}, async (context) => {
          assert.equal(context.http.authInfo.token, '');
          assert.equal(context.http.authInfo.clientId, actor.clientId);
          const progressToken = context.mcpReq._meta?.progressToken;
          if (progressToken) await context.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1 } });
          return { content: [{ type: 'text', text: actor.userId + ':' + era }] };
        });
        server.registerTool('card_update', {}, () => ({ content: [{ type: 'text', text: 'synthetic write scope' }] }));
        server.registerResource('fixture', 'planner://fixture/board', {}, () => ({
          contents: [{ uri: 'planner://fixture/board', text: actor.userId }],
        }));
        server.registerPrompt('fixture_prompt', {}, () => ({
          messages: [{ role: 'user', content: { type: 'text', text: actor.userId } }],
        }));
      },
      admitListen: (_actor, filter) => filter && Object.keys(filter).length === 1 && filter.toolsListChanged === true,
    };
    const app = buildApp({ native: { origin, proxyToken: 'a'.repeat(64),
      readAccess: async () => ({ kind: 'ready' }),
      auth: { read: async () => { throw new Error('MCP must not use a browser session.'); } }, oauth, mcp: surface } });
    const { complete, options, open } = await serverFixture(t, app);
    const discover = modernBody('server/discover');
    const discovery = await complete(options(discover, 'ignored-discovery-bearer'));
    assert.equal(discovery.status, 200);
    assert.deepEqual(discovery.json.result.supportedVersions, [modern]);
    assert.deepEqual(discovery.json.result.capabilities.tools, { listChanged: true });
    assert.equal(discovery.json.result._meta['io.modelcontextprotocol/serverInfo'].name, 'Planner');
    assert.equal(accessChecks, 0);
    assert.equal(seen.size, 0);
    for (const method of ['GET', 'DELETE']) {
      const unsupported = await complete({ method });
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.allow, 'POST');
      assert.equal(unsupported.headers['mcp-session-id'], undefined);
    }
    assert.equal((await complete(options(discover, undefined, { Origin: 'https://cross-origin.example.test' }))).status, 403);
    assert.equal((await complete(options(discover, undefined, { 'x-fixture-unmarked': '1' }))).status, 403);
    assert.equal((await complete(options(discover, undefined, { Origin: origin }))).status, 200);
    for (const malformed of [
      options(discover, undefined, { 'MCP-Protocol-Version': legacy }),
      options(discover, undefined, { 'Mcp-Method': 'tools/list' }),
      { payload: discover, headers: { 'Mcp-Method': 'server/discover' } },
      options(modernBody('server/discover', {}, { [capabilities]: [] })),
      options(modernBody('server/discover', {}, { [protocol]: '2027-01-01' }), undefined, { 'MCP-Protocol-Version': '2027-01-01' }),
      { payload: { ...body('server/discover'), id: undefined } },
      options({ ...discover, id: undefined }),
      { payload: [discover] },
      { payload: '{"jsonrpc":' },
    ]) assert.equal((await complete(malformed)).status, 400, JSON.stringify(malformed));
    assert.equal((await complete(options(discover, undefined, { Accept: 'application/json' }))).status, 406);
    assert.equal((await complete(options(discover, undefined, { Accept: 'application/json, text/event-stream;q=0' }))).status, 406);
    assert.equal((await complete({ ...options(discover), headers: { ...options(discover).headers, 'Content-Type': 'text/plain' } })).status, 415);
    for (const chunked of [true, false]) {
      assert.equal((await complete({ payload: ' '.repeat(64 * 1024 + 1), chunked })).status, 413);
    }

    const initialize = body('initialize', { protocolVersion: legacy, capabilities: {}, clientInfo: { name: 'legacy fixture', version: '1' } });
    const unauthorized = await complete({ payload: initialize, headers: { Cookie: 'planner_session=not-a-bearer' } });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers['www-authenticate'], /resource_metadata="https:\/\/planner-mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/u);
    const init = await open({ payload: initialize, token: tokenA });
    assert.equal(init.statusCode, 200);
    assert.equal(init.headers['mcp-session-id'], undefined);
    const initMessages = [];
    for await (const frame of frames(init)) initMessages.push(frame);
    const initResult = initMessages.at(-1).result;
    assert.equal(initResult.protocolVersion, legacy);
    assert.equal(initResult.capabilities.resources.subscribe, false);
    assert.equal(initResult.capabilities.tools.listChanged, false);
    const initialized = await complete({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token: tokenA, headers: { 'MCP-Protocol-Version': legacy } });
    assert.equal(initialized.status, 202);
    assert.equal(initialized.text, '');
    assert.equal(initialized.headers['mcp-session-id'], undefined);
    assert.equal((await complete({ payload: body('tools/list'), token: tokenA })).status, 400);
    assert.equal((await complete({ payload: body('tools/list'), token: tokenA, headers: { 'MCP-Protocol-Version': '2025-06-18' } })).status, 400);
    const listed = await open({ payload: body('tools/list'), token: tokenA, headers: { 'MCP-Protocol-Version': legacy } });
    assert.equal(listed.statusCode, 200);
    const tools = [];
    for await (const frame of frames(listed)) tools.push(frame);
    assert.deepEqual(tools.at(-1).result.tools.map(({ name }) => name).sort(), ['card_update', 'fixture_actor']);
    assert.equal((await complete({ payload: { ...initialize, params: { ...initialize.params, _meta: { [protocol]: modern } } }, token: tokenA })).status, 400);

    const named = modernBody('tools/call', { name: 'fixture_actor' });
    assert.equal((await complete(options(named, undefined, { 'Mcp-Name': 'fixture_actor' }))).status, 401);
    assert.equal((await complete(options(named, tokenA, { 'Mcp-Name': 'wrong_tool' }))).status, 400);
    assert.equal((await complete(options(named, tokenA))).status, 400);
    for (const [method, field, name] of [['prompts/get', 'name', 'fixture_prompt'], ['resources/read', 'uri', 'planner://fixture/board']]) {
      const rpc = modernBody(method, { [field]: name });
      assert.equal((await complete(options(rpc, tokenA, { 'Mcp-Name': 'mismatch' }))).status, 400);
      assert.equal((await complete(options(rpc, tokenA, { 'Mcp-Name': name }))).status, 200);
    }
    const writeRequest = modernBody('tools/call', { name: 'card_update' });
    const checkedBefore = accessChecks;
    for (const headers of [{}, { 'Mcp-Name': 'fixture_actor' }]) {
      assert.equal((await complete(options(writeRequest, tokenA, headers))).status, 400);
    }
    assert.equal(accessChecks, checkedBefore);
    const write = await complete(options(writeRequest, tokenA, { 'Mcp-Name': 'card_update' }));
    assert.equal(write.status, 403);
    assert.match(write.headers['www-authenticate'], /insufficient_scope/u);
    const permitted = await complete(options(writeRequest, tokenWrite, { 'Mcp-Name': 'card_update' }));
    assert.equal(permitted.status, 200);
    assert.equal(permitted.json.result.content[0].text, 'synthetic write scope');
    const replies = await Promise.all([tokenA, tokenB].map((token) => complete(options(named, token, { 'Mcp-Name': 'fixture_actor' }))));
    assert.deepEqual(replies.map((reply) => [reply.status, reply.json.id, reply.json.result.content[0].text]),
      [[200, 1, 'alpha:modern'], [200, 1, 'beta:modern']]);
    for (const reply of replies) assert.equal(reply.headers['mcp-session-id'], undefined);
    assert.equal(seen.size >= 7, true);

    const progress = await open(options(modernBody('tools/call', { name: 'fixture_actor' }, { progressToken: 'fixture' }),
      tokenA, { 'Mcp-Name': 'fixture_actor' }));
    assert.match(progress.headers['content-type'], /^text\/event-stream/u);
    const progressFrames = [];
    for await (const frame of frames(progress)) progressFrames.push(frame);
    assert.equal(progressFrames[0].method, 'notifications/progress');
    assert.equal(progressFrames.at(-1).result.content[0].text, 'alpha:modern');

    const listen = modernBody('subscriptions/listen', { notifications: { toolsListChanged: true } });
    assert.equal((await complete(options(listen))).status, 401);
    const listenBefore = accessChecks;
    assert.equal((await complete({ payload: listen, token: tokenA, headers: { 'MCP-Protocol-Version': modern } })).status, 400);
    assert.equal(accessChecks, listenBefore);
    const refused = modernBody('subscriptions/listen', { notifications: { resourceSubscriptions: ['planner://fixture/board'] } });
    assert.equal((await complete(options(refused, tokenA))).status, 403);
    assert.equal(bus.listenerCount, 0);
    const [left, right] = await Promise.all([tokenA, tokenB].map((token) => open(options(listen, token))));
    const [leftFrames, rightFrames] = [frames(left), frames(right)];
    for (const iterator of [leftFrames, rightFrames]) {
      const { value: ack } = await iterator.next();
      assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
      assert.equal(ack.params._meta[subscriptionId], 1);
      assert.deepEqual(ack.params.notifications, { toolsListChanged: true });
    }
    assert.equal(bus.listenerCount, 2);
    left.destroy();
    for (let attempt = 0; bus.listenerCount !== 1 && attempt < 30; attempt++) await delay(20);
    assert.equal(bus.listenerCount, 1);
    bus.publish({ kind: 'tools_list_changed' });
    assert.equal((await rightFrames.next()).value.method, 'notifications/tools/list_changed');
    await app.closeMcp();
    assert.equal((await rightFrames.next()).value.result.resultType, 'complete');
    assert.equal((await rightFrames.next()).done, true);
    assert.equal(bus.listenerCount, 0);
    assert.equal((await complete(options(discover))).status, 503);
  });
