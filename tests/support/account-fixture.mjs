import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountCredentials, recoverAccountChanges } from '../../apps/backend/dist/application/auth/account-credentials.js';
import { createAccountDirectory } from '../../apps/backend/dist/application/auth/account-directory.js';
import { defaultPreferences } from '../../apps/backend/dist/application/auth/accounts.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { buildApp } from '../../apps/backend/dist/build-app.js';
import { startAdminSocket } from '../../apps/backend/dist/native/admin-socket.js';
import { startProxySocket } from '../../apps/backend/dist/native/proxy-socket.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';

export const password = 'Synthetic phrase with numbers 42';
export const changedPassword = 'Still synthetic changed password 87';
export const proxyToken = 'a'.repeat(64);

export async function accountFixture({ db, directory }) {
  const installationId = randomUUID();
  const generationId = randomUUID();
  let time = new Date('2026-03-19T13:13:59.719Z');
  const now = () => time;
  const hasher = createPasswordHasher();
  const verifier = await hasher.encode(password);
  const scope = { generationId };
  await db.collection('installation').insertOne({
    _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: generationId,
    setup: { mode: 'fresh', pendingAction: 'complete' },
  });
  await migrateStorageSchema(db, installationId);
  const writer = join(directory, 'writer');
  await mkdir(writer);
  await chmod(writer, 0o750);
  const owner = { uid: process.getuid(), gid: process.getgid() };
  const writerGate = () => new CommandGate(acquireWriterDirectory(writer, owner, owner));
  let gate = writerGate();

  async function seed(email, options = {}) {
    const id = options.id ?? randomUUID();
    const account = {
      _id: workspaceKey(generationId, id), ...scope, id, revision: 1, name: options.name ?? email.split('@')[0],
      email, normalizedEmail: email.toLowerCase(), username: options.username ?? null,
      normalizedUsername: options.username?.toLowerCase() ?? null, role: options.role ?? 'boardUser',
      disabledAt: options.disabledAt ?? null, createdAt: now(), preferences: { ...defaultPreferences },
    };
    if (options.password !== false) account.localAuth = {
      passwordVerifier: options.invalidVerifier ? {} : verifier, credentialsVersion: 1, mfa: options.factor ?? 'none',
    };
    if (options.requiresMfaEnrollment) account.requiresMfaEnrollment = true;
    await db.collection('users').insertOne(account);
    return account;
  }

  const accountServices = (checkpoint) => ({
    ...createAccountDirectory(db, installationId, gate, hasher, now),
    ...createAccountCredentials(db, installationId, gate, hasher, now, checkpoint),
  });
  const readAccess = async () => gate.ready ? { kind: 'ready' } : { kind: 'unavailable', reason: 'schema-or-recovery' };
  const sessions = () => createBrowserSessions(db, installationId, gate, hasher, now);

  async function startBrowser(origin) {
    const proxyDir = join(directory, 'proxy');
    await mkdir(proxyDir);
    await chmod(proxyDir, 0o711);
    const app = buildApp({
      frontendRoot: fileURLToPath(new URL('../../apps/frontend/dist/', import.meta.url)),
      native: { origin, proxyToken, readAccess, auth: { confirm: async () => false, ...sessions(), accountManagement: accountServices() } },
    });
    const closeProxy = await startProxySocket(proxyDir, app);
    return { path: join(proxyDir, 'http.sock'), close: async () => { await closeProxy(); await app.close(); } };
  }

  async function startOperator() {
    const adminDir = join(directory, 'admin');
    await mkdir(adminDir);
    await chmod(adminDir, 0o750);
    const close = await startAdminSocket(adminDir, readAccess, accountServices());
    return { path: join(adminDir, 'admin.sock'), close };
  }

  await new CommandJournal(gate, db, installationId).recover();
  return {
    db, directory, scope, seed, sessions, accountServices, startBrowser, startOperator, installationId, generationId,
    advanceBy: (ms) => { time = new Date(time.getTime() + ms); },
    gate: () => gate,
    async reboot() {
      await gate.closeAndDrain();
      gate = writerGate();
      await new CommandJournal(gate, db, installationId).recover(() => recoverAccountChanges(db, installationId));
    },
    close: () => gate.closeAndDrain(),
  };
}

export function proxyHeaders(origin) {
  return { 'X-Planner-Proxy-Token': proxyToken, 'X-Forwarded-Host': new URL(origin).host,
    'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.9' };
}

export function callSocket(socketPath, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: {
      ...(payload && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers,
    } }, async (response) => {
      try {
        let data = '';
        for await (const chunk of response) data += chunk;
        try { data = JSON.parse(data); } catch { /* Shell pages contain HTML. */ }
        resolve({ status: response.statusCode, headers: response.headers, data });
      } catch (error) { reject(error); }
    });
    req.once('error', reject).end(payload);
  });
}
