import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { healthOperations, PLANNER_VERSION } from '@planner/contracts';
import { build } from 'vite';
import { buildApp } from '../apps/server/dist/build-app.js';
import { decodeHealthLive, decodeHealthReadiness } from '../apps/web/src/api/health.ts';

const callerId = 'c0f3f51b-7ec9-4bf8-94b0-dc0d0f111bbb';
const callerHeaders = { 'request-id': callerId, 'x-request-id': callerId };
const sentinel = 'private database connection failure sentinel';

test('Fastify checks readiness per request and returns safe responses', async (t) => {
  const probes = [
    async () => true,
    async () => false,
    async () => { throw new Error(sentinel); },
  ];
  let probeCalls = 0;
  const app = buildApp({ isReady: () => probes[probeCalls++]() });
  t.after(() => app.close());

  const live = await app.inject({ url: '/health/live', headers: callerHeaders });
  assert.equal(live.statusCode, 200);
  assert.equal(live.headers['cache-control'], 'no-store');
  assert.equal(decodeHealthLive(live.json()).status, 'live');
  assert.equal(probeCalls, 0);

  const requestIds = new Set([live.json().requestId]);
  for (const [statusCode, status] of [[200, 'ready'], [503, 'unavailable'], [503, 'unavailable']]) {
    const response = await app.inject({ url: '/health/ready', headers: callerHeaders });
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, new RegExp(sentinel));
    const decoded = decodeHealthReadiness(response.json());
    assert.equal(decoded.status, status);
    requestIds.add(decoded.requestId);
  }
  assert.equal(probeCalls, 3);
  assert.equal(requestIds.size, 4);
  assert.equal(requestIds.has(callerId), false);

  const stillLive = await app.inject('/health/live');
  assert.equal(stillLive.statusCode, 200);
  assert.equal(decodeHealthLive(stillLive.json()).status, 'live');
  assert.equal(probeCalls, 3);
});

test('the browser decoders consume the strict shared operation schemas', () => {
  assert.equal(healthOperations.live.id, 'health.live');
  assert.equal(healthOperations.readiness.id, 'health.readiness');
  for (const operation of Object.values(healthOperations)) {
    assert.equal(operation.kind, 'read');
    assert.deepEqual(operation.input.parse({}), {});
    assert.throws(() => operation.input.parse({ access: 'admin' }));
  }

  const ready = { status: 'ready', version: PLANNER_VERSION, requestId: callerId };
  assert.deepEqual(decodeHealthReadiness(ready), healthOperations.readiness.output.parse(ready));
  assert.throws(() => decodeHealthLive(ready));
  assert.throws(() => decodeHealthReadiness({ ...ready, status: 'live' }));
  assert.throws(() => decodeHealthReadiness({ ...ready, requestId: 'client-provided' }));
  assert.throws(() => decodeHealthReadiness({ ...ready, version: '0.0.0' }));
  assert.throws(() => decodeHealthReadiness({ ...ready, details: sentinel }));
  assert.throws(() => decodeHealthReadiness({ status: 'unavailable', version: PLANNER_VERSION }));
});

test('the compiled server answers the Vite browser-target decoder and shuts down', { timeout: 20_000 }, async () => {
  const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
  const entry = fileURLToPath(new URL('../apps/web/src/api/health.ts', import.meta.url));
  const output = await build({
    root: webRoot,
    logLevel: 'silent',
    build: { write: false, lib: { entry, formats: ['es'] } },
  });
  const chunks = [output].flat().flatMap((bundle) => bundle.output);
  const decoder = chunks.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  assert.ok(decoder, 'Vite emitted the browser decoder');
  assert.deepEqual(decoder.imports, []);
  const modules = Object.keys(decoder.modules).join('\n');
  assert.match(modules, /\/packages\/contracts\/dist\/health\.js/u);
  assert.match(modules, /\/node_modules\/zod\//u);
  assert.doesNotMatch(modules, /node:|\/apps\/server\/|\/node_modules\/(fastify|mongodb|pg|oidc-provider|@modelcontextprotocol)\//u);
  const browser = await import(`data:text/javascript;base64,${Buffer.from(decoder.code).toString('base64')}`);

  const main = fileURLToPath(new URL('../apps/server/dist/main.js', import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, PLANNER_HTTP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  try {
    const [address] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) });
    assert.match(address, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/u);
    const request = (path) => fetch(new URL(path, address), {
      headers: callerHeaders,
      signal: AbortSignal.timeout(5_000),
    });

    const liveResponse = await request('/health/live');
    assert.equal(liveResponse.status, 200);
    const live = browser.decodeHealthLive(await liveResponse.json());
    assert.equal(live.status, 'live');
    assert.equal(live.version, PLANNER_VERSION);
    assert.notEqual(live.requestId, callerId);

    const readyResponse = await request('/health/ready');
    assert.equal(readyResponse.status, 503);
    const ready = browser.decodeHealthReadiness(await readyResponse.json());
    assert.equal(ready.status, 'unavailable');
    assert.equal(ready.version, PLANNER_VERSION);
    assert.notEqual(ready.requestId, callerId);
    assert.notEqual(ready.requestId, live.requestId);
    assert.throws(() => browser.decodeHealthReadiness({ ...ready, details: sentinel }));
  } finally {
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.kill('SIGTERM');
    try {
      assert.deepEqual(await exited, [0, null], 'compiled child shut down cleanly');
    } finally {
      clearTimeout(forceKill);
      lines.close();
    }
  }
});
