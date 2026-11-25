import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { Readable } from 'node:stream';

export const modern = '2026-07-28';
export const legacy = '2025-11-25';
const clientId = 'synthetic-mcp-reader';
const redirect = 'https://reader.example.test/callback';
export const client = { client_id: clientId, client_name: 'Synthetic MCP reader', redirect_uris: [redirect] };
const json = 'application/json';
export const form = 'application/x-www-form-urlencoded';

export function httpsOpen({ origin, certificate }, path, { method = 'GET', body, type = json, cookies, headers, signal } = {}) {
  const data = body === undefined ? undefined : type === form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { method, ca: certificate, signal, headers: {
      ...(data !== undefined && { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) }),
      ...(cookies?.size && { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') }),
      ...headers,
    } }, (response) => {
      for (const header of response.headers['set-cookie'] ?? []) {
        const value = header.split(';')[0];
        const position = value.indexOf('=');
        if (position !== -1) cookies?.set(value.slice(0, position), value.slice(position + 1));
      }
      resolve(response);
    });
    req.setTimeout(8000, () => req.destroy(new Error('The local Planner HTTPS fixture did not respond.')));
    req.once('error', reject).end(data);
  });
}

export async function sdkHttpsFetch(tls, input, init) {
  const request = new Request(input, init);
  const target = new URL(request.url);
  assert.equal(target.origin, tls.origin);
  const response = await httpsOpen(tls, target.pathname + target.search, {
    method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal,
    ...(request.body && { body: await request.json() }),
  });
  const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
  return new Response(body, { status: response.statusCode, headers: response.headers });
}

export async function collectHttps(response) {
  const parts = [];
  for await (const chunk of response) parts.push(chunk);
  const text = Buffer.concat(parts).toString('utf8');
  const contentType = response.headers['content-type'] ?? '';
  const value = !text ? null : contentType.includes(json) ? JSON.parse(text) : contentType.includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).at(-1) : null;
  return { status: response.statusCode, headers: response.headers, text, value };
}

export async function httpsCall(tls, path, options) {
  return collectHttps(await httpsOpen(tls, path, options));
}

export function rpcOptions(version, method, params = {}, token, id = 1, extraHeaders) {
  const name = params.name ?? params.uri;
  return { method: 'POST', headers: {
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version,
    ...(version === modern && { 'Mcp-Method': method, ...(name && { 'Mcp-Name': name }) }),
    ...(token && { Authorization: 'Bearer ' + token }),
    ...extraHeaders,
  }, body: { jsonrpc: '2.0', id, method, params: { ...params, ...(version === modern && { _meta: {
    'io.modelcontextprotocol/protocolVersion': modern, 'io.modelcontextprotocol/clientCapabilities': {},
  } }) } } };
}

export function rpcCall(call, version, method, params = {}, token) {
  return call('/mcp', rpcOptions(version, method, params, token));
}

export async function consentReader(call, origin, cookies, offline = false) {
  const verifier = randomBytes(32).toString('base64url');
  const resource = origin + '/mcp';
  const request = await call('/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'local-fixture',
    scope: offline ? 'planner:read offline_access' : 'planner:read', resource, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }), { cookies });
  assert.equal(request.status, 303, request.text);
  const interaction = request.headers.location;
  const formPage = await call(interaction, { cookies });
  assert.equal(formPage.status, 200, formPage.text);
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(formPage.text)?.[1];
  assert.ok(csrf);
  const authorize = await call(interaction, {
    method: 'POST', type: form, cookies, body: { csrf, decision: 'allow', ...(offline && { offline: 'yes' }) }, headers: { Origin: origin },
  });
  assert.equal(authorize.status, 303, authorize.text);
  const callback = await call(new URL(authorize.headers.location, origin).pathname, { cookies });
  const result = new URL(callback.headers.location);
  assert.equal(result.origin + result.pathname, redirect);
  assert.equal(result.searchParams.get('state'), 'local-fixture');
  const token = await call('/oauth/token', { method: 'POST', type: form, body: {
    grant_type: 'authorization_code', client_id: clientId, code: result.searchParams.get('code'),
    code_verifier: verifier, redirect_uri: redirect, resource,
  } });
  assert.equal(token.status, 200, token.text);
  assert.match(token.value.scope, /(?:^| )planner:read(?: |$)/u);
  assert.equal(!!token.value.refresh_token, offline);
  return token.value;
}
