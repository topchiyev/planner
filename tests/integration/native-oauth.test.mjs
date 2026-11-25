import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { Secret, TOTP } from 'otpauth';
import { defaultPreferences } from '../../apps/backend/dist/application/auth/accounts.js';
import { createMfaManagement } from '../../apps/backend/dist/application/auth/mfa-management.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
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
    const app = (clients = [client]) => buildApp({ native: { origin, proxyToken, readAccess: async () => access, auth: { ...sessions, confirm: async () => false,
      mfa: { manage, verify: (input) => sessions.verifyMfa(input) } },
      oauth: createNativeOAuthRuntime(origin, installationId, gate, key, (run) => run(db), clients) } });
    let server = await serve(app(), fixture);
    const call = (path, options) => server.call(path, options);
    const post = (path, body, jar, type = json, headers = { Origin: origin }) => call(path, { method: 'POST', body, type, jar, headers });
    const requestCode = (overrides = {}) => '/oauth/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'synthetic-state', resource,
      scope: 'planner:read planner:write', code_challenge_method: 'S256', code_challenge: challenge, ...overrides,
    });
    const follow = (response, jar) => call(new URL(response.headers.location, origin).pathname, { jar });
    const consent = (path, input, jar, headers) => post(path, input, jar, form, headers);
    const token = (authorizationCode, overrides = {}) => post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
      code: authorizationCode, code_verifier: verifier, redirect_uri: redirect, resource, ...overrides }, undefined, form, {});
    const jar = cookies();
    async function interaction() {
      const requested = await call(requestCode(), { jar });
      assert.equal(requested.status, 303, requested.text);
      assert.match(requested.headers.location, /^\/oauth\/interaction\/[A-Za-z0-9_-]+$/u);
      return requested.headers.location;
    }
    const csrfFrom = (response) => {
      assert.equal(response.status, 200, response.text);
      return /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(response.text)?.[1];
    };

    async function approve(path, write = true) {
      const accepted = await consent(path, { csrf: csrfFrom(await call(path, { jar })), decision: 'allow',
        ...(write && { write: 'yes' }) }, jar);
      assert.equal(accepted.status, 303, accepted.text);
      const callback = await follow(accepted, jar);
      const code = new URL(callback.headers.location).searchParams.get('code');
      assert.ok(code);
      return code;
    }

    try {
      const discovery = await call('/.well-known/oauth-protected-resource/mcp', { headers: { Forwarded: 'host=attacker.invalid' } });
      assert.equal(discovery.status, 200);
      assert.deepEqual(discovery.json, { resource, authorization_servers: [origin], scopes_supported: ['planner:read'],
        bearer_methods_supported: ['header'] });
      assert.equal((await call('/.well-known/oauth-protected-resource/mcp', { headers: { 'x-test-proxy': 'unmarked' } })).status, 403);
      const unauthorized = await call('/mcp');
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers['www-authenticate'], `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
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
      assert.equal((await call('/mcp', { headers: bearer })).status, 501);
      assert.equal((await call('/mcp?access_token=' + full.json.access_token)).status, 401);

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

      const pendingRestart = await interaction();
      await server.close();
      server = await serve(app(), fixture);
      assert.deepEqual((await call('/oauth/jwks')).json, publicKeys);
      assert.ok(csrfFrom(await call(pendingRestart, { jar })));
      assert.equal((await call('/mcp', { headers: bearer })).status, 501);

      const codeBeforeLogout = await approve(pendingRestart);
      const currentBrowser = await call('/api/v1/session', { jar });
      assert.equal(currentBrowser.status, 200);
      const logout = await call('/api/v1/session', { method: 'DELETE', jar,
        headers: { Origin: origin, 'X-CSRF-Token': currentBrowser.json.csrfToken } });
      assert.equal(logout.status, 204);
      assert.equal((await call('/api/v1/session', { jar })).status, 401);
      const loggedOutSwap = await token(codeBeforeLogout);
      assert.equal(loggedOutSwap.status, 400);
      assert.equal(loggedOutSwap.json.error, 'invalid_grant');
      assert.equal((await call('/mcp', { headers: bearer })).status, 501);

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
      assert.equal((await call('/mcp', { headers: readBearer })).status, 501);

      await server.close();
      server = await serve(app([]), fixture);
      assert.equal((await call('/mcp', { headers: bearer })).status, 401);
      await server.close();
      server = await serve(app(), fixture);
      assert.equal((await call('/mcp', { headers: bearer })).status, 501);

      // Verify each durable condition independently of the revocation sweeps.
      const saved = await users.findOne(actor);
      for (const [field, changed, original] of [
        ['localAuth.credentialsVersion', saved.localAuth.credentialsVersion + 1, saved.localAuth.credentialsVersion],
        ['localAuth.factor.id', randomUUID(), saved.localAuth.factor.id],
        ['disabledAt', new Date(), null],
      ]) {
        await users.updateOne(actor, { $set: { [field]: changed } });
        assert.equal((await call('/mcp', { headers: bearer })).status, 401);
        await users.updateOne(actor, { $set: { [field]: original } });
        assert.equal((await call('/mcp', { headers: bearer })).status, 501);
      }

      await connections.updateOne({ _id: firstConnection._id }, { $set: { revokedAt: new Date() } });
      assert.equal((await call('/mcp', { headers: readBearer })).status, 401);
      assert.equal((await call('/mcp', { headers: bearer })).status, 501);
      const reauth = await post('/api/v1/session/login', { identifier, password, requireMfaChallenge: true }, jar);
      const verified = await post('/api/v1/session/verify-mfa', { challengeId: reauth.json.challengeId,
        recoveryCode: factor.recoveryCodes[1] }, jar);
      assert.equal(verified.status, 200);
      const disabled = await call('/api/v1/me/mfa', { method: 'DELETE', type: json, jar,
        headers: { Origin: origin, 'X-CSRF-Token': verified.json.csrfToken }, body: { password, recoveryCode: factor.recoveryCodes[2] } });
      assert.equal(disabled.status, 204);
      assert.equal((await call('/mcp', { headers: bearer })).status, 401);
      assert.equal(await connections.countDocuments({ generationId, userId: actorId, revokedAt: null }), 0);

      access = { kind: 'enrollment', step: 'account-recovery' };
      assert.equal((await call('/mcp')).status, 503);
      assert.equal((await call(requestCode())).status, 503);
      access = { kind: 'ready' };
      await publishSyntheticMigration(db, { installationId, generationId, actorId });
      assert.equal((await call(requestCode())).status, 503);
      assert.equal(gate.ready, true);
    } finally { await server.close(); await gate.closeAndDrain(); }
  }));
