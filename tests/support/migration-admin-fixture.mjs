import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPreferences } from '../../apps/backend/dist/application/auth/accounts.js';
import { issueMigrationAdminRecovery, consumeMigrationAdminRecovery, recoverMigrationAdmin } from '../../apps/backend/dist/application/auth/migration-admin.js';
import { recoverFactorChanges } from '../../apps/backend/dist/application/auth/mfa-account.js';
import { createMfaManagement } from '../../apps/backend/dist/application/auth/mfa-management.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { importRunKey, migrationCursors } from '../../apps/backend/dist/application/migration/checkpoint.js';
import { buildApp } from '../../apps/backend/dist/build-app.js';
import { startProxySocket } from '../../apps/backend/dist/native/proxy-socket.js';
import { inspectColdMigrationAccess } from '../../apps/backend/dist/native/runtime-access.js';
import { legacyPublicId, workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { proxyToken } from './account-fixture.mjs';

const frontendRoot = fileURLToPath(new URL('../../apps/frontend/dist/', import.meta.url));
export const stagedPassword = 'Synthetic PLANKA recovery phrase 42';

export async function migrationAdminFixture({ db, directory }) {
  const installationId = randomUUID();
  const generationId = randomUUID();
  const sourceInstanceId = randomUUID();
  const createdAt = new Date();
  let time = createdAt;
  const now = () => time;
  const scope = { installationId, generationId, runId: randomUUID() };
  const fingerprint = { sha256: '1'.repeat(64) };
  const position = { pass: 'media', table: 'user_account' };
  const token = migrationCursors(randomBytes(32)).seal({ ...scope, ...position, fingerprint: fingerprint.sha256 }, null);
  const run = { ...importRunKey(scope), state: 'verified', fingerprint, manifestSha256: '2'.repeat(64),
    verification: { reportSha256: '3'.repeat(64), detailSha256: '4'.repeat(64) }, verificationStartedAt: createdAt, createdAt, updatedAt: createdAt,
    checkpoint: { ...position, lastSourceId: null, token }, source: { instanceId: sourceInstanceId, release: '2.3.1', edition: 'community' } };
  await db.collection('installation').insertOne({ _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: null,
    setup: { mode: 'import', pendingAction: 'migration-preflight', enrollmentGenerationId: null } });
  await migrateStorageSchema(db, installationId);
  await db.collection('importRuns').insertOne(run);
  const owner = { uid: process.getuid(), gid: process.getgid() };
  const writer = join(directory, 'writer');
  await mkdir(writer, { mode: 0o750 });
  await chmod(writer, 0o750);
  const acquire = () => acquireWriterDirectory(writer, owner, owner);
  const hasher = createPasswordHasher();
  const mfaKey = createSecretKey(randomBytes(32));
  let gate;
  const replay = async () => { await recoverMigrationAdmin(db, installationId); await recoverFactorChanges(db, installationId); };
  const startGate = async () => {
    gate = new CommandGate(acquire());
    await gate.recover(replay);
    return gate;
  };
  async function seed(sourceId, { role = 'admin', disabled = false, mfa = false, generation = generationId, email = `${sourceId}@staged.example.test` } = {}) {
    const id = legacyPublicId(sourceInstanceId, 'user_account', sourceId);
    const identity = { _id: workspaceKey(generation, id), id, generationId: generation };
    await db.collection('users').insertOne({ ...identity, name: `Synthetic ${sourceId}`, role, revision: 1, email,
      normalizedEmail: email.toLowerCase(), username: null, normalizedUsername: null, disabledAt: disabled ? createdAt : null, createdAt,
      requiresMfaEnrollment: mfa, preferences: defaultPreferences,
      localAuth: { passwordVerifier: null, credentialsVersion: 1, mfa: mfa ? 'enrollment-required' : 'none' } });
    await db.collection('importIds').insertOne({ ...identity, entity: 'user_account', sourceId, sourceInstanceId, provenance: { createdAt: null, updatedAt: null } });
    return identity;
  }
  async function issue(selection, rotate = false) {
    const lease = acquire();
    try { return await issueMigrationAdminRecovery(db, lease, run, { runId: run.id, rotate, ...selection }, now()); }
    finally { lease.release(); }
  }
  const consume = (grant, afterClaim) => consumeMigrationAdminRecovery(db, installationId, gate, hasher,
    { grant, password: stagedPassword }, now, afterClaim);
  const mfa = () => createMfaManagement(db, installationId, gate, mfaKey, hasher, now);
  async function startBrowser(origin) {
    const proxyDir = join(directory, 'proxy');
    await mkdir(proxyDir, { mode: 0o711 });
    await chmod(proxyDir, 0o711);
    const sessions = createBrowserSessions(db, installationId, gate, hasher, now, mfaKey);
    const app = buildApp({ frontendRoot, native: { origin, proxyToken,
      readAccess: () => gate.readSnapshot(() => inspectColdMigrationAccess(db, installationId, now())),
      auth: { ...sessions, confirm: async () => false, migrationRecovery: (input) => consumeMigrationAdminRecovery(db, installationId, gate, hasher, input, now),
        mfa: { manage: mfa(), verify: async () => null } },
    } });
    const stop = await startProxySocket(proxyDir, app);
    return { path: join(proxyDir, 'http.sock'), close: async () => { await stop(); await app.close(); } };
  }
  return { db, run, scope, seed, issue, now, setTime: (next) => { time = next; }, consume, mfa, startGate, startBrowser,
    closeGate: () => gate?.closeAndDrain(), replay, hasher };
}
