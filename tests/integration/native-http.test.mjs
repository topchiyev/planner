import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);
const { buildApp } = await import('../../apps/backend/dist/build-app.js');
const { boundedRuntimeProbe } = await import('../../apps/backend/dist/native/runtime-access.js');
const { startAdminSocket } = await import('../../apps/backend/dist/native/admin-socket.js');
const frontendRoot = fileURLToPath(new URL('../../apps/frontend/dist/', import.meta.url));
const origin = 'https://planner.example.test:8443';
const authority = new URL(origin).host;
const proxyToken = randomBytes(32).toString('hex');
const proxyHeaders = {
  host: 'forged.local', forwarded: 'for=10.4.0.4;host=forged.local;proto=http',
  'x-forwarded-host': authority, 'x-forwarded-proto': 'https', 'x-forwarded-for': '2001:db8::17',
  'x-forwarded-prefix': '/untrusted', 'x-real-ip': '10.4.0.4', origin,
};

function operatorRequest(socketPath, path) {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path }, async (response) => {
      let body = '';
      for await (const chunk of response) body += chunk;
      resolve({ status: response.statusCode, data: JSON.parse(body) });
    });
    call.once('error', reject).end();
  });
}

test('native transport gates every protected route and strips forged forwarding metadata', async (t) => {
  let access = { kind: 'unavailable', reason: 'migration' };
  const app = buildApp({ frontendRoot, native: { origin, proxyToken, readAccess: async () => access } });
  t.after(() => app.close());
  let protectedCalls = 0;
  for (const [method, url] of [
    ['GET', '/api/v1/projects'], ['GET', '/files/original'], ['GET', '/api/v1/boards/board/events'],
    ['POST', '/api/v1/session/login'], ['POST', '/mcp'], ['GET', '/oauth/consent'],
    ['POST', '/api/v1/recovery/consume'], ['POST', '/api/v1/mfa/enrollment'], ['POST', '/api/v1/mfa/enrollment/verify'],
  ]) {
    app.route({ method, url, handler: (req) => {
      protectedCalls += 1;
      return { context: req.plannerConnection, headers: req.headers, host: req.host, ip: req.ip };
    } });
  }
  const inject = (method, url, headers = {}, remoteAddress = '127.0.0.1') => app.inject({ method, url, headers, remoteAddress });
  const denied = [
    ['GET', '/api/v1/projects'], ['HEAD', '/files/original'], ['GET', '/files/original'],
    ['GET', '/api/v1/boards/board/events'], ['POST', '/api/v1/session/login'], ['POST', '/mcp'],
    ['GET', '/oauth/consent'], ['GET', '/workspace'], ['GET', '/boards/board/cards/card?context=archive'],
    ['POST', '/api/v1/recovery/consume'], ['GET', '/recover'], ['GET', '/enroll-mfa'], ['GET', '/admin/status'],
  ];
  for (const [method, url] of denied) {
    const response = await inject(method, url, { ...proxyHeaders, 'x-planner-proxy-token': proxyToken });
    assert.equal(response.statusCode, 503, `${method} ${url}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    if (method === 'HEAD') assert.equal(response.body, '');
  }
  assert.equal(protectedCalls, 0);
  assert.equal((await inject('GET', '/health/live')).statusCode, 200);
  const readiness = await inject('GET', '/health/ready');
  assert.equal(readiness.statusCode, 503);
  assert.deepEqual(Object.keys(readiness.json()).sort(), ['requestId', 'status', 'version']);
  const asset = (await readdir(join(frontendRoot, 'assets'))).find((name) => name.endsWith('.js'));
  assert.ok(asset);
  for (const method of ['GET', 'HEAD']) assert.equal((await inject(method, '/assets/' + asset)).statusCode, 200);
  assert.equal((await inject('GET', '/assets/%2e%2e/index.html')).statusCode, 503);

  access = { kind: 'enrollment', step: 'recovery' };
  assert.equal((await inject('GET', '/recover')).statusCode, 200);
  assert.equal((await inject('GET', '/enroll-mfa')).statusCode, 503);
  assert.equal((await inject('GET', '/api/v1/recovery/consume', proxyHeaders)).statusCode, 503);
  assert.equal((await inject('POST', '/api/v1/recovery/consume', proxyHeaders)).statusCode, 503);
  assert.equal((await inject('POST', '/api/v1/recovery/consume', {
    ...proxyHeaders, origin: 'https://other.invalid', 'x-planner-proxy-token': proxyToken,
  })).statusCode, 503);
  const proxied = { ...proxyHeaders, 'x-planner-proxy-token': proxyToken };
  assert.equal((await inject('POST', '/api/v1/recovery/consume', proxied, '127.0.0.2')).statusCode, 503);
  const allowed = await inject('POST', '/api/v1/recovery/consume', proxied);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.json().context, { origin, clientAddress: '2001:db8::17' });
  assert.equal(allowed.json().host, authority);
  assert.equal(allowed.json().ip, '127.0.0.1');
  assert.deepEqual(Object.keys(allowed.json().headers).sort(), ['host', 'origin', 'user-agent']);
  assert.equal((await inject('POST', '/api/v1/mfa/enrollment', proxied)).statusCode, 503);
  access = { kind: 'enrollment', step: 'mfa' };
  assert.equal((await inject('HEAD', '/enroll-mfa')).statusCode, 200);
  assert.equal((await inject('POST', '/api/v1/mfa/enrollment/verify', proxied)).statusCode, 200);
  assert.equal((await inject('POST', '/api/v1/recovery/consume', proxied)).statusCode, 503);

  access = { kind: 'ready' };
  assert.equal((await inject('GET', '/health/ready')).statusCode, 200);
  assert.equal((await inject('GET', '/workspace')).statusCode, 200);
  assert.equal((await inject('GET', '/status')).statusCode, 404);
  for (const headers of [proxyHeaders, { ...proxied, 'x-forwarded-for': '192.0.2.9, 192.0.2.10' }]) {
    const direct = (await inject('GET', '/api/v1/projects', headers)).json();
    assert.deepEqual(direct.context, { origin, clientAddress: null });
    assert.equal(direct.host, authority);
  }
});

test('timed-out readiness is bounded and keeps a single probe in flight', async () => {
  let checks = 0;
  let resolve;
  const check = boundedRuntimeProbe(() => {
    checks += 1;
    return new Promise((settle) => { resolve = settle; });
  }, 20);
  const app = buildApp({ native: { origin, readAccess: check } });
  try {
    const responses = await Promise.all([app.inject('/health/ready'), app.inject('/health/ready')]);
    assert.deepEqual(responses.map((response) => response.statusCode), [503, 503]);
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    assert.equal((await app.inject('/health/ready')).statusCode, 503);
    assert.equal(checks, 1);
    resolve({ kind: 'ready' });
  } finally { await app.close(); }
});

test('operator status lives in its private socket namespace and retains a colliding path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planner-admin-'));
  const socket = join(directory, 'admin.sock');
  await chmod(directory, 0o750);
  const readAccess = async () => ({ kind: 'enrollment', step: 'recovery' });
  try {
    await symlink('/dev/null', socket);
    await assert.rejects(startAdminSocket(directory, readAccess), /unexpected ownership or permissions/u);
    assert.equal((await lstat(socket)).isSymbolicLink(), true);
    await rm(socket);
    const close = await startAdminSocket(directory, readAccess);
    try {
      assert.equal((await lstat(socket)).mode & 0o777, 0o600);
      assert.deepEqual(await operatorRequest(socket, '/status'), {
        status: 200, data: { version: '0.1.0', access: { kind: 'enrollment', step: 'recovery' } },
      });
      assert.equal((await operatorRequest(socket, '/restart')).status, 404);
      await assert.rejects(startAdminSocket(directory, readAccess), /is in use/u);
    } finally { await close(); }
    await assert.rejects(lstat(socket), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
