import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const release = '/opt/planner/current';
const backend = pathToFileURL(`${release}/apps/backend/dist/`);
const origin = 'https://planner.example.test';
const eventPath = '/api/v1/boards/board-fixture/events';
const [mode] = process.argv.slice(2);

if (mode === 'serve') {
  const { buildApp } = await import(new URL('build-app.js', backend));
  const proxyToken = (await readFile('/etc/planner/proxy-token', 'utf8')).trim();
  const app = buildApp({ native: { origin, proxyToken, readAccess: async () => ({ kind: 'ready' }) } });
  app.get('/fixture/context', (req) => ({
    context: req.plannerConnection, host: req.host, rawAddress: req.ip,
    forwarded: Object.keys(req.headers).filter((name) => name.startsWith('x-forwarded-')
      || name.startsWith('x-planner-') || ['forwarded', 'x-real-ip'].includes(name)),
  }));
  app.get(eventPath, async (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    reply.raw.write('data: first\n\n');
    await delay(350);
    reply.raw.write('data: second\n\n');
    await delay(550);
    reply.raw.end();
  });
  await app.listen({ host: '127.0.0.1', port: 27430 });
  process.on('SIGTERM', () => { void app.close(); });
} else if (mode === 'stream') {
  const ca = await readFile('/etc/ssl/planner/fullchain.pem');
  await new Promise((resolve, reject) => {
    const call = request({
      hostname: '127.0.0.1', port: 443, servername: 'planner.example.test', ca,
      path: eventPath, headers: { Host: 'planner.example.test', Accept: 'text/event-stream' },
    }, (response) => {
      (async () => {
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'], /^text\/event-stream/u);
        assert.equal(response.headers['content-encoding'], undefined);
        const events = [];
        let pending = '';
        for await (const chunk of response) {
          pending += chunk;
          let delimiter = pending.indexOf('\n\n');
          while (delimiter !== -1) {
            events.push({ event: pending.slice(0, delimiter), time: performance.now() });
            pending = pending.slice(delimiter + 2);
            delimiter = pending.indexOf('\n\n');
          }
        }
        const closed = performance.now();
        assert.deepEqual(events.map(({ event }) => event), ['data: first', 'data: second']);
        assert.ok(events[1].time - events[0].time > 180, 'events arrived in separate delayed chunks');
        assert.ok(closed - events[1].time > 250, 'the second event arrived before EOF');
      })().then(resolve, reject);
    });
    call.once('error', reject);
    call.setTimeout(5_000, () => call.destroy(new Error('SSE response timed out')));
    call.end();
  });
  console.log('SSE chunks arrived independently before EOF through the nginx TLS proxy.');
} else if (mode === 'database') {
  const { connectConfiguredNativeMongo } = await import(new URL('native/mongo-readiness.js', backend));
  const config = JSON.parse(await readFile('/etc/planner/planner.json', 'utf8'));
  const client = await connectConfiguredNativeMongo(config);
  const records = client.db('planner').collection('installation');
  const key = { _id: 'installation' };
  const saved = await records.findOne(key);
  async function check(reason, operatorReason) {
    const response = await fetch('http://127.0.0.1:27430/health/ready', { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()).sort(), ['requestId', 'status', 'version']);
    const cached = await fetch('http://127.0.0.1:27430/workspace', { signal: AbortSignal.timeout(5_000) });
    assert.equal(cached.status, 503);
    const operator = await new Promise((resolve, reject) => {
      const call = get({ socketPath: '/run/planner/admin.sock', path: '/status' }, (reply) => {
        (async () => {
          assert.equal(reply.statusCode, 200);
          let body = '';
          for await (const chunk of reply) body += chunk;
          return JSON.parse(body);
        })().then(resolve, reject);
      });
      call.once('error', reject);
      call.setTimeout(5_000, () => call.destroy(new Error('Operator status timed out')));
    });
    assert.deepEqual(operator.access, { kind: 'unavailable', reason: operatorReason });
    console.log(`Verified public denial during ${reason}.`);
  }
  try {
    await records.updateOne(key, { $set: { installationId: '44fa512e-a887-4a2d-8a3b-08b8119b719a' } });
    await check('wrong installation UUID', 'database');
    await records.updateOne(key, { $set: {
      installationId: saved.installationId, activeGenerationId: '99f38c73-9959-4bf7-b79b-dc8c0f576268', schemaVersion: 1,
    } });
    await check('pending schema and recovery verification', 'schema-or-recovery');
  } finally {
    try {
      await records.updateOne(key, { $set: {
        installationId: saved.installationId, activeGenerationId: saved.activeGenerationId, schemaVersion: saved.schemaVersion,
      } });
    } finally { await client.close(); }
  }
} else {
  throw new Error('Choose a guest fixture operation.');
}
