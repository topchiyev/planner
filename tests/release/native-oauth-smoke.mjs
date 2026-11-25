import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://planner.example.test';
const hostname = new URL(origin).hostname;
const resource = origin + '/mcp';
const clientId = 'native-cli';
const redirect = 'http://127.0.0.1:49153/callback';
const dummyEmail = 'offline-oauth@planner-fixture.invalid';
const dummyPassword = 'Synthetic offline OAuth credential';
const certificate = await readFile('/etc/ssl/planner/fullchain.pem');
const setup = JSON.parse(await readFile(process.argv[2], 'utf8'));
const cookies = new Map();

function call(path, { method = 'GET', body, form = false, browser = false, headers } = {}) {
  const encoded = body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', servername: hostname, ca: certificate, path, method,
      signal: AbortSignal.timeout(8000), headers: { Host: hostname,
        ...(encoded !== undefined && { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          'Content-Length': Buffer.byteLength(encoded) }),
        ...(browser && { Origin: origin, Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') }), ...headers },
    }, async (response) => {
      try {
        const parts = [];
        for await (const chunk of response) parts.push(chunk);
        const text = Buffer.concat(parts).toString();
        if (browser) for (const header of response.headers['set-cookie'] ?? []) {
          const pair = header.split(';', 1)[0];
          const separator = pair.indexOf('=');
          const name = pair.slice(0, separator);
          const value = pair.slice(separator + 1);
          if (value) cookies.set(name, value);
          else cookies.delete(name);
        }
        resolve({ status: response.statusCode, headers: response.headers, text,
          json: response.headers['content-type']?.includes('json') && text ? JSON.parse(text) : null });
      } catch (error) { reject(error); }
    });
    client.once('error', reject).end(encoded);
  });
}

function probeMcp(headers = {}) {
  return call('/mcp', {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', ...headers },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Offline OAuth fixture', version: '1' },
    } },
  });
}

async function readiness(expected) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await call('/health/ready').catch(() => undefined))?.status === expected) return;
    await delay(250);
  }
  assert.fail('The installed Planner application did not reach the expected readiness.');
}

await readiness(503);
const recover = await call('/api/v1/recovery/consume', { method: 'POST', browser: true,
  body: { grant: setup.firstAdminGrant.token, name: 'Offline OAuth operator', email: dummyEmail, password: dummyPassword } });
assert.equal(recover.status, 200);
await readiness(200);
const challenge = await probeMcp();
assert.equal(challenge.status, 401);
assert.match(challenge.headers['www-authenticate'], /scope="planner:read"/u);
const metadata = await call('/.well-known/oauth-authorization-server');
assert.equal(metadata.status, 200);
assert.equal(metadata.json.issuer, origin);
assert.deepEqual(metadata.json.grant_types_supported.sort(), ['authorization_code', 'refresh_token']);
assert.equal((await call('/.well-known/oauth-protected-resource/mcp')).json.resource, resource);

const login = await call('/api/v1/session/login', { method: 'POST', browser: true,
  body: { identifier: dummyEmail, password: dummyPassword } });
assert.equal(login.status, 200);
assert.equal(login.json.status, 'authenticated');
const verifier = randomBytes(32).toString('base64url');
const authorization = await call('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId,
  redirect_uri: redirect, state: 'native-oauth-smoke', scope: 'planner:read offline_access', resource,
  code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }), { browser: true });
assert.equal(authorization.status, 303);
const interaction = authorization.headers.location;
assert.match(interaction, /^\/oauth\/interaction\/[A-Za-z0-9_-]+$/u);
const prompt = await call(interaction, { browser: true });
assert.equal(prompt.status, 200);
assert.match(prompt.text, /Offline synthetic client/u);
const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(prompt.text)?.[1];
assert.ok(csrf);
const accepted = await call(interaction, { method: 'POST', form: true, browser: true, body: { csrf, decision: 'allow', offline: 'yes' } });
assert.equal(accepted.status, 303);
const resumed = new URL(accepted.headers.location, origin);
assert.equal(resumed.origin, origin);
const responded = await call(resumed.pathname + resumed.search, { browser: true });
assert.equal(responded.status, 303);
const callback = new URL(responded.headers.location);
assert.equal(callback.origin + callback.pathname, redirect);
assert.equal(callback.searchParams.get('iss'), origin);
assert.equal(callback.searchParams.get('state'), 'native-oauth-smoke');
const code = callback.searchParams.get('code');
assert.ok(code);

const swap = { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, resource };
assert.equal((await call('/oauth/token', { method: 'POST', form: true, body: swap })).status, 400);
const issued = await call('/oauth/token', { method: 'POST', form: true, body: { ...swap, redirect_uri: redirect } });
assert.equal(issued.status, 200);
assert.equal(issued.json.scope, 'planner:read');
assert.equal(issued.json.expires_in, 900);
assert.match(issued.json.refresh_token, /^[A-Za-z0-9_-]+$/u);
const tokenHeaders = { Authorization: 'Bearer ' + issued.json.access_token };
assert.equal((await probeMcp(tokenHeaders)).status, 200);
const rotated = await call('/oauth/token', { method: 'POST', form: true, body: {
  grant_type: 'refresh_token', client_id: clientId, refresh_token: issued.json.refresh_token,
} });
assert.equal(rotated.status, 200);
assert.notEqual(rotated.json.refresh_token, issued.json.refresh_token);

const own = await call('/api/v1/me/connections', { browser: true });
assert.equal(own.status, 200);
assert.equal(own.json.connections.length, 1);
const [grant] = own.json.connections;
assert.equal(grant.name, 'Offline synthetic client');
assert.equal(grant.offline, true);
assert.equal(grant.status, 'active');
assert.equal(own.text.includes(issued.json.access_token), false);
assert.equal(own.text.includes(issued.json.refresh_token), false);
const revoke = await call('/api/v1/me/connections/' + grant.id, { method: 'DELETE', browser: true,
  headers: { 'X-CSRF-Token': login.json.csrfToken } });
assert.equal(revoke.status, 204);
assert.equal((await probeMcp(tokenHeaders)).status, 401);
assert.equal((await call('/api/v1/session', { browser: true })).status, 200);
