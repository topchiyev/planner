import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { get, request as localRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { accountApprovalResultSchema, accountApprovalSchema, migrationDigestSchema, PLANNER_VERSION } from '@planner/contracts';
import {
  nativeSetupOptions, type NativeInstallationConfig, type NativeSetupOptions,
} from '@planner/contracts/native';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import type { MongoClient } from 'mongodb';
import { z } from 'zod';
import { BackupError, digestPattern } from '../application/backup/archive.js';
import { activateRestore, inspectBackup, readActivatedRestore, stageRestore } from '../application/backup/restore.js';
import { openPrivateBlobVerifier, openRestoreMedia } from '../application/backup/restore-media.js';
import { createMediaDecoder } from '../application/media/decoder.js';
import { activateVerifiedMigration, type MigrationActivationReceipt } from '../application/migration/activation.js';
import { enableMigrationWrites, inspectMigrationCutover, rollbackMigration } from '../application/migration/cutover.js';
import { MigrationError } from '../application/migration/manifest.js';
import { inspectMigration, migrationPath, parseMigrationInput, withMigrationSnapshot, type MigrationInput } from '../application/migration/preflight.js';
import { prepareMigration } from '../application/migration/prepare.js';
import { collectMigrationVerification } from '../application/migration/verification.js';
import { firstAdminBinding } from '../application/auth/first-admin.js';
import { issueMigrationAdminRecovery, readMigrationAdminActivationProof, migrationAdminRequest } from '../application/auth/migration-admin.js';
import { WriterOwnershipError, type WriterLease } from '../application/command-gate/writer-lease.js';
import {
  currentStorageSchema, migrateStorageSchema, readInstallation, requireCurrentSchema, StorageSchemaError, verifyStorageSchema,
  type InstallationDocument,
} from '../storage/schema.js';
import {
  checkDirectory, checkReceipt, ensureNativeMongo, inspectNativeMongo, packageAccount, readProtectedFile,
  stopNativeMongoBootstrap,
} from './mongo-host.js';
import { adminRuntimeDirectory } from './admin-socket.js';
import { backupBlobs, backupCreateEndpoint, backupRoot, backupStaging, checkRestoreCapacity, createRestoreIntent,
  parseRestoreOptions, readRestoreIntent, type RestoreIntent } from './backup-state.js';
import { nativeMigrationMediaPublisher } from './migration-media.js';
import { assertMigrationTarget, beginMigrationVerification, checkMigrationCapacity, clearMigrationServiceResume,
  dismissNativeMigrationServiceResume, enableRestoredMigrationWrites, hasMigrationServiceResume, migrationVerificationPage, openNativeMigrationDirectory,
  persistMigrationVerification, prepareMigrationCutover, publicMigrationStatus, publicMigrationVerification, publishMigrationPreflight, readMigrationVerification,
  readProtectedMigrationRun, recordMigrationServiceResume, stageProtectedMigrationRun, withNativeVerificationScratch } from './migration-state.js';
import { assertNativeMfaKey, ensureNativeMfaKey, installRestoredMfaKey, readNativeMfaKey } from './mfa-key.js';
import { databaseName, NativeMongoError, parseMongoCredentials } from './mongo-identity.js';
import { connectVerifiedNativeMongo, mongoCredentialFile } from './mongo-readiness.js';
import type { RuntimeAccess } from './runtime-access.js';
import {
  checkPackagePorts, createSetupIntent, pendingAction, persistSetup, publishInstallationConfig, readInstallationConfig,
  readPersistedSetup, readSetupIntent, sameSetup,
} from './setup-state.js';
import { acquireNativeWriter } from './writer.js';

const statePath = '/var/lib/planner';
const app = 'planner.service';
const database = 'planner-mongodb.service';
const preflight = fileURLToPath(new URL('../../../../lib/native-preflight', import.meta.url));

function command(executable: string, args: string[], errorMessage: string) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0) throw new NativeMongoError(errorMessage);
  return result.stdout.trim();
}

function systemctl(...args: string[]) {
  return command('/usr/bin/systemctl', args, 'Could not control or inspect the installed Planner services.');
}

function verifyOwnership() {
  if (process.getuid?.() !== 0) throw new NativeMongoError('Planner operator commands require root.');
  command(preflight, ['ownership'], 'Planner native ownership checks failed.');
  checkDirectory(statePath, 0, 0, 0o711);
  return { receipt: checkReceipt(), appGroup: packageAccount('-g', 'planner'), appUid: packageAccount('-u', 'planner') };
}

async function withInstallationLock<T>(callback: (owner: ReturnType<typeof verifyOwnership>) => Promise<T>) {
  verifyOwnership();
  const before = checkDirectory(statePath, 0, 0, 0o711);
  const lock = openSync(statePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const sameDirectory = () => {
      const current = checkDirectory(statePath, 0, 0, 0o711);
      const locked = fstatSync(lock);
      return before.dev === locked.dev && before.ino === locked.ino
        && current.dev === locked.dev && current.ino === locked.ino;
    };
    if (!sameDirectory()
        || spawnSync('/usr/bin/flock', ['-nx', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock] }).status !== 0
        || !sameDirectory()) {
      throw new NativeMongoError('The Planner installation lock is unavailable.');
    }
    return await callback(verifyOwnership());
  } finally {
    closeSync(lock);
  }
}

function listeners(port: number) {
  const entries = command('/usr/bin/ss', ['-H', '-ltn', '--cgroup', `sport = :${port}`],
    'Could not inspect the selected Planner ports.');
  return entries ? entries.split('\n').map((entry) => entry.trim().split(/\s+/u)) : [];
}

function validateNativePorts({ appPort, dbPort }: Pick<NativeSetupOptions, 'appPort' | 'dbPort'>) {
  const result = spawnSync(preflight, ['ports', String(appPort), String(dbPort)], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) {
    throw new NativeMongoError(result.stderr?.trim() || 'The selected Planner ports could not be verified.');
  }
}

function appListening(port: number, configured: boolean) {
  const entries = listeners(port);
  if (entries.length === 0) return false;
  if (!configured || entries.length !== 1 || entries[0][3] !== `127.0.0.1:${port}`
      || !entries[0].includes(`cgroup:/system.slice/${app}`)) {
    throw new NativeMongoError(`Planner application port ${port} is occupied by a different listener.`);
  }
  return true;
}

async function startApplication(port: number, { enableServices = true } = {}) {
  systemctl('start', app);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (appListening(port, true)) {
      if (enableServices) systemctl('enable', database, app);
      return;
    }
    if (systemctl('show', '--property=ActiveState', '--value', app) === 'failed') break;
    await delay(200);
  }
  throw new NativeMongoError('The Planner application listener did not become available.');
}

async function connectOwnedDatabase(expected: Pick<NativeInstallationConfig, 'installationId' | 'dbPort'>, appGroup: number) {
  const contents = readProtectedFile(mongoCredentialFile, appGroup, 0o640);
  const credential = parseMongoCredentials(contents === undefined ? undefined : JSON.parse(contents));
  if (credential.installationId !== expected.installationId || credential.port !== expected.dbPort) {
    throw new NativeMongoError('The Planner database credential does not match the setup installation.');
  }
  return connectVerifiedNativeMongo(credential);
}

async function prepareStorage(client: MongoClient, installationId: string, writer: WriterLease) {
  writer.assertHeld();
  const database = client.db(databaseName);
  const existing = await readInstallation(database, installationId);
  if (existing.schemaVersion === currentStorageSchema) await verifyStorageSchema(database, installationId);
  else await migrateStorageSchema(database, installationId);
}

// Lifecycle commands take the installation lock before acquiring the writer lease.
async function withStoppedWriter<T>(operation: (writer: WriterLease) => Promise<T>) {
  const writer = acquireNativeWriter();
  try {
    if (systemctl('show', '--property=MainPID', '--value', app) !== '0') {
      throw new NativeMongoError('Stop the Planner application before updating installation storage.');
    }
    return await operation(writer);
  } finally { writer.release(); }
}

function stopDatabase() {
  systemctl('stop', database);
  stopNativeMongoBootstrap();
}

function verifySetupFiles(
  config: NativeInstallationConfig | undefined, intent: ReturnType<typeof readSetupIntent>, restore?: RestoreIntent,
) {
  const options = restore?.config ?? intent?.options;
  if (restore && intent) throw new BackupError('Planner has conflicting setup and restore intents.');
  if (config && (!options || !sameSetup(config, options) || (restore && config.installationId !== restore.config.installationId))) {
    throw new NativeMongoError('The Planner configuration has no matching setup intent.');
  }
  checkPackagePorts(options, !!config);
}

function protectedAdminSocket(owner: ReturnType<typeof verifyOwnership>) {
  const run = lstatSync('/run');
  if (!run.isDirectory() || run.uid !== 0 || run.gid !== 0 || (run.mode & 0o022) !== 0) {
    throw new NativeMongoError('The Planner operator socket is unavailable.');
  }
  checkDirectory(adminRuntimeDirectory, owner.appUid, owner.appGroup, 0o750);
  const socketPath = `${adminRuntimeDirectory}/admin.sock`;
  const stat = lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== owner.appUid || stat.gid !== owner.appGroup
      || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) {
    throw new NativeMongoError('The Planner operator socket is unavailable.');
  }
  return socketPath;
}

async function appAccess(owner: ReturnType<typeof verifyOwnership>) {
  try {
    const socketPath = protectedAdminSocket(owner);
    const signal = AbortSignal.timeout(3_500);
    return await new Promise<RuntimeAccess | undefined>((resolve) => {
      const request = get({ socketPath, path: '/status', signal }, (response) => {
        void (async () => {
          let body = '';
          response.setEncoding('utf8');
          for await (const chunk of response) {
            body += chunk;
            if (body.length > 1024) return undefined;
          }
          const result = response.statusCode === 200 ? JSON.parse(body) as { access?: RuntimeAccess } : null;
          return result?.access;
        })().then(resolve, () => resolve(undefined));
      });
      request.once('error', () => resolve(undefined));
    });
  } catch {
    return undefined;
  }
}

async function storedPendingAction(config: NativeInstallationConfig, appGroup: number) {
  try {
    const client = await connectOwnedDatabase(config, appGroup);
    try {
      const installation = await readInstallation(client.db(databaseName), config.installationId);
      requireCurrentSchema(installation);
      if (installation.setup?.mode !== config.mode) return undefined;
      const binding = firstAdminBinding(installation);
      if (binding) return binding.published ? 'complete' : 'first-admin-enrollment';
      if (installation.activeGenerationId === null && installation.setup.pendingAction === 'migration-preflight') {
        return 'migration-preflight';
      }
    } finally { await client.close(); }
  } catch {
    // A configured but unverified installation reports unknown setup state.
  }
}

async function status(owner: ReturnType<typeof verifyOwnership>, confirmed?: boolean) {
  const config = readInstallationConfig(owner.appGroup);
  const intent = readSetupIntent(owner.receipt);
  const restore = readRestoreIntent(owner.receipt);
  verifySetupFiles(config, intent, restore);
  const serviceState = (unit: string) => {
    const state = systemctl('show', '--property=ActiveState', '--value', unit);
    return ['active', 'inactive', 'activating', 'deactivating', 'failed'].includes(state) ? state : 'unknown';
  };
  const services = { application: serviceState(app), database: serviceState(database) };
  const access = config && services.application === 'active' ? await appAccess(owner) : undefined;
  const ready = access?.kind === 'ready';
  let action: string;
  if (!config) action = restore ? 'resume-restore' : intent ? 'resume-setup' : 'setup';
  else if (ready || confirmed) action = 'complete';
  else if (confirmed === false || access?.kind === 'enrollment'
      || (access?.kind === 'unavailable' && access.reason === 'migration')) action = pendingAction(config.mode);
  else action = (services.database === 'active' ? await storedPendingAction(config, owner.appGroup) : undefined) ?? 'unknown';
  return {
    version: PLANNER_VERSION,
    configuration: config ? 'configured' : intent || restore ? 'configuring' : 'unconfigured',
    mode: restore?.config.mode ?? intent?.options.mode ?? null,
    pendingAction: action,
    readiness: ready ? 'ready' : 'unavailable',
    services,
  };
}

async function setup(options: NativeSetupOptions) {
  validateNativePorts(options);
  return withInstallationLock(async (owner) => {
    const existing = readInstallationConfig(owner.appGroup);
    if (readRestoreIntent(owner.receipt)) throw new BackupError('Use the existing Planner backup restore workflow.');
    let intent = readSetupIntent(owner.receipt);
    verifySetupFiles(existing, intent);
    if (intent && !sameSetup(intent.options, options)) {
      throw new NativeMongoError('Repeat setup with the originally selected mode, origin and ports.');
    }
    if (appListening(options.appPort, !!existing)) {
      if (!existing || !intent) throw new NativeMongoError('The running Planner setup could not be verified.');
      const client = await connectOwnedDatabase(existing, owner.appGroup);
      try {
        const db = client.db(databaseName);
        await verifyStorageSchema(db, existing.installationId);
        await assertNativeMfaKey(db, existing.installationId, readNativeMfaKey(existing.installationId, owner.appGroup));
        const { confirmed, grant } = await readPersistedSetup(client, existing.installationId, intent);
        return { ...await status(owner, confirmed), ...(grant && { firstAdminGrant: grant }) };
      } finally { await client.close(); }
    }
    const { confirmed, grant } = await withStoppedWriter(async (writer) => {
      if (!intent) {
        if (['/etc/planner/mongodb-init.json', '/etc/planner/mongod.conf', mongoCredentialFile]
          .some((path) => lstatSync(path, { throwIfNoEntry: false }))) {
          throw new NativeMongoError('The Planner database already has initialization artifacts without a setup intent.');
        }
        inspectNativeMongo(options.dbPort);
        intent = createSetupIntent(owner.receipt, options);
      }
      const active = await ensureNativeMongo(options.dbPort);
      if (existing && existing.installationId !== active.installationId) {
        throw new NativeMongoError('The Planner application and database installation identities do not match.');
      }
      const client = await connectOwnedDatabase(active, owner.appGroup);
      try {
        const saved = await client.db(databaseName).collection<InstallationDocument>('installation').findOne(
          { _id: 'installation', installationId: active.installationId }, { projection: { schemaVersion: 1 } },
        );
        const existingStorage = saved?.schemaVersion !== undefined || !!existing;
        if (existingStorage) await prepareStorage(client, active.installationId, writer);
        const issued = await persistSetup(client, active.installationId, intent, writer);
        if (!existingStorage) await prepareStorage(client, active.installationId, writer);
        await ensureNativeMfaKey(client.db(databaseName), active.installationId, owner.appGroup, writer);
        publishInstallationConfig({ formatVersion: 1, installationId: active.installationId, ...options }, owner.appGroup);
        return issued;
      } finally { await client.close(); }
    });
    await startApplication(options.appPort);
    return { ...await status(owner, confirmed), ...(grant && { firstAdminGrant: grant }) };
  });
}

async function control(action: 'start' | 'stop' | 'restart') {
  return withInstallationLock(async (owner) => {
    if (action === 'stop') {
      const config = readInstallationConfig(owner.appGroup);
      if (config?.mode === 'import') await dismissNativeMigrationServiceResume(config);
      systemctl('stop', app);
      await withStoppedWriter(async () => stopDatabase());
      return status(owner);
    }
    const config = readInstallationConfig(owner.appGroup);
    verifySetupFiles(config, readSetupIntent(owner.receipt), readRestoreIntent(owner.receipt));
    if (!config) throw new NativeMongoError('Complete Planner setup before starting its services.');
    validateNativePorts(config);
    const listening = appListening(config.appPort, true);
    if (action === 'start' && listening && systemctl('show', '--property=MainPID', '--value', database) !== '0') {
      const client = await connectOwnedDatabase(config, owner.appGroup);
      try {
        const db = client.db(databaseName);
        await verifyStorageSchema(db, config.installationId);
        await assertNativeMfaKey(db, config.installationId, readNativeMfaKey(config.installationId, owner.appGroup));
      } finally { await client.close(); }
      if (config.mode === 'import') await dismissNativeMigrationServiceResume(config);
      return status(owner);
    }
    if (action === 'restart' || listening) systemctl('stop', app);
    await withStoppedWriter(async (writer) => {
      if (action === 'restart') stopDatabase();
      const active = await ensureNativeMongo(config.dbPort);
      if (active.installationId !== config.installationId) {
        throw new NativeMongoError('The Planner application and database installation identities do not match.');
      }
      const client = await connectOwnedDatabase(config, owner.appGroup);
      try {
        await prepareStorage(client, config.installationId, writer);
        await ensureNativeMfaKey(client.db(databaseName), config.installationId, owner.appGroup, writer);
      } finally { await client.close(); }
    });
    await startApplication(config.appPort);
    if (config.mode === 'import') await dismissNativeMigrationServiceResume(config);
    return status(owner);
  });
}

async function verifyInstalledStorage() {
  const owner = verifyOwnership();
  const config = readInstallationConfig(owner.appGroup);
  verifySetupFiles(config, readSetupIntent(owner.receipt), readRestoreIntent(owner.receipt));
  if (!config) throw new NativeMongoError('Complete Planner setup before verifying its storage.');
  const client = await connectOwnedDatabase(config, owner.appGroup);
  try {
    const result = await verifyStorageSchema(client.db(databaseName), config.installationId);
    return { schemaVersion: result.schemaVersion, activeGeneration: result.activeGenerationId !== null };
  } finally {
    await client.close();
  }
}

async function localBackupRequest(owner: ReturnType<typeof verifyOwnership>) {
  const socketPath = protectedAdminSocket(owner);
  const data = await new Promise<unknown>((resolve, reject) => {
    const request = localRequest({ socketPath, method: 'POST', path: backupCreateEndpoint,
      headers: { 'Content-Length': 0 } }, (response) => {
      void (async () => {
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) {
          body += chunk;
          if (body.length > 1024) throw new BackupError();
        }
        if (response.statusCode !== 200) throw new BackupError('The verified Planner backup could not be captured.');
        return JSON.parse(body);
      })().then(resolve, reject);
    });
    request.once('error', reject).end();
  });
  if (!data || typeof data !== 'object' || Object.keys(data).length !== 2 || !('backupId' in data) || !('manifestSha256' in data)
    || typeof data.manifestSha256 !== 'string' || !digestPattern.test(data.manifestSha256)) throw new BackupError();
  const backupId = publicIdSchema.parse(data.backupId);
  return { backupId, manifestSha256: data.manifestSha256, directory: `${backupRoot}/${backupId}` };
}

async function restoreBackup(options: ReturnType<typeof parseRestoreOptions>) {
  return withInstallationLock(async (owner) => {
    const { destination, fingerprint } = options;
    if (readInstallationConfig(owner.appGroup) || readSetupIntent(owner.receipt)) {
      throw new BackupError('Restore requires a clean Planner installation with no active setup.');
    }
    let intent = readRestoreIntent(owner.receipt);
    validateNativePorts(destination);
    appListening(destination.appPort, false);
    return withStoppedWriter(async (writer) => {
      const verified = await inspectBackup(options.archive, { uid: 0, gid: 0 }, fingerprint);
      try {
        if (intent) {
          if (intent.fingerprint !== fingerprint || intent.proof !== verified.proof || intent.config.installationId !== verified.config.installationId
            || intent.generationId !== verified.archive.manifest.activeGenerationId
            || !sameSetup(intent.config, { ...verified.config, ...destination })) {
            throw new BackupError('Repeat restore with the original backup, origin and ports.');
          }
        } else {
          checkPackagePorts(undefined, false);
          if (inspectNativeMongo(destination.dbPort).journal || readdirSync(backupBlobs).length || readdirSync(backupStaging).length
            || readProtectedFile('/etc/planner/mfa-key.json', owner.appGroup, 0o640) !== undefined) {
            throw new BackupError('Restore requires a clean Planner database and media installation.');
          }
          checkRestoreCapacity(verified);
          intent = createRestoreIntent(owner.receipt, verified, destination);
        }
        const { config } = intent;
        await ensureNativeMongo(destination.dbPort, config.installationId);
        const client = await connectOwnedDatabase(config, owner.appGroup);
        try {
          const media = await openRestoreMedia({ staging: backupStaging, blobs: backupBlobs,
            owner: { uid: owner.appUid, gid: owner.appGroup }, fingerprint });
          try {
            const result = await stageRestore(client.db(databaseName), writer, media, verified);
            installRestoredMfaKey(config.installationId, owner.appGroup, writer, verified.key, verified.source.mfaKeyDigest);
            return result;
          } finally { await media.close(); }
        } finally { await client.close(); }
      } finally { await verified.close(); }
    });
  });
}

async function waitForRestoredReadiness(owner: ReturnType<typeof verifyOwnership>) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await appAccess(owner))?.kind === 'ready') return;
    await delay(250);
  }
  throw new BackupError('The activated Planner application has not passed readiness.');
}

async function activateBackup(fingerprint: string) {
  if (!digestPattern.test(fingerprint)) throw new BackupError('A verified backup manifest SHA-256 is required.');
  return withInstallationLock(async (owner) => {
    const installed = readInstallationConfig(owner.appGroup);
    const intent = readRestoreIntent(owner.receipt);
    verifySetupFiles(installed, readSetupIntent(owner.receipt), intent);
    if (!intent || intent.fingerprint !== fingerprint) throw new BackupError('A matching verified staged backup is required.');
    const { config } = intent;
    validateNativePorts(config);
    const verifyKey = (digest: string | undefined) => {
      if (readNativeMfaKey(config.installationId, owner.appGroup).digest !== digest) {
        throw new BackupError('The staged Planner key does not match the restored database.');
      }
    };
    if (installed && appListening(config.appPort, true)) {
      const client = await connectOwnedDatabase(config, owner.appGroup);
      try {
        const result = await readActivatedRestore(client.db(databaseName), config.installationId, fingerprint, intent.proof, verifyKey);
        await waitForRestoredReadiness(owner);
        return result;
      } finally { await client.close(); }
    }
    appListening(config.appPort, !!installed);
    const result = await withStoppedWriter(async (writer) => {
      await ensureNativeMongo(config.dbPort, config.installationId);
      const client = await connectOwnedDatabase(config, owner.appGroup);
      try {
        const media = await openRestoreMedia({ staging: backupStaging, blobs: backupBlobs,
          owner: { uid: owner.appUid, gid: owner.appGroup }, fingerprint });
        try { return await activateRestore(client.db(databaseName), writer, media, config.installationId, fingerprint, intent.proof, verifyKey, undefined, !installed); }
        finally { await media.close(); }
      } finally { await client.close(); }
    });
    publishInstallationConfig(config, owner.appGroup);
    await startApplication(config.appPort);
    await waitForRestoredReadiness(owner);
    return result;
  });
}

async function handleAccountApproval(operation: 'inspect' | 'confirm', id: string, format: string) {
  const owner = verifyOwnership();
  const socketPath = protectedAdminSocket(owner);
  const applied = operation === 'confirm';
  const data = await new Promise<unknown>((resolve, reject) => {
    const request = localRequest({ socketPath, signal: AbortSignal.timeout(6_000), method: applied ? 'POST' : 'GET',
      path: `/accounts/approvals/${id}${applied ? '/confirm' : ''}`, headers: { 'Content-Length': 0 } }, (response) => {
      void (async () => {
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) {
          body += chunk;
          if (body.length > 4096) throw new NativeMongoError('The Planner operator response is invalid.');
        }
        if (response.statusCode !== 200) {
          if (response.statusCode === 409 && JSON.parse(body).code === 'WORKSPACE_READ_ONLY') {
            throw new NativeMongoError('Workspace writes are paused during migration cutover.');
          }
          throw new NativeMongoError('The account approval is unavailable. Check its expiration, actor and target.');
        }
        return JSON.parse(body);
      })().then(resolve, reject);
    });
    request.once('error', reject).end();
  });
  const result = applied ? accountApprovalResultSchema.parse(data) : { approval: accountApprovalSchema.parse(data) };
  if (format === 'json') {
    console.log(JSON.stringify(result));
    return;
  }
  const { approval } = result;
  console.log(`Account approval ${approval.id} ${applied ? 'applied' : 'pending'}.`);
  console.log(`Administrator ${approval.actorId}, account ${approval.targetId}, revision ${approval.revision}.`);
  const change = approval.change;
  console.log(change.action === 'role' ? `Set the site role to ${change.role}.`
    : change.action === 'availability' ? (change.disabled ? 'Disable this account.' : 'Reactivate this account.')
    : 'Reset this account password.');
  console.log(`Approval expires at ${approval.expiresAt}.`);
  if ('recovery' in result && result.recovery) {
    console.log(`Local recovery grant expires at ${result.recovery.expiresAt}. Give it privately to this account holder.`);
    console.log(result.recovery.grant);
  }
}

const migrationOwner = { uid: 0, gid: 0 };

async function migrationConfig(name: 'postgres' | 'objects') {
  const path = name === 'postgres' ? '/etc/planner/migration-pg.services' : '/etc/planner/migration-assets.json';
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600
          || info.size === 0 || info.size > 64 * 1024) throw new Error();
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length || (await file.stat()).ctimeMs !== info.ctimeMs) throw new Error();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { await file.close(); }
  } catch {
    throw new MigrationError(name === 'postgres' ? 'source-service' : 'asset-manifest', 'The selected protected migration service configuration is unavailable.');
  }
}

async function prepareCapture(input: unknown) {
  verifyOwnership();
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 2 || !('archive' in input)
      || !migrationPath(input.archive) || !('workDir' in input) || !migrationPath(input.workDir)) {
    throw new MigrationError('capture-format', 'Specify an absolute private archive and work directory.');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { return await prepareMigration(input.archive, input.workDir, migrationOwner, controller.signal); }
  catch (error) {
    if (error instanceof MigrationError) throw error;
    if (controller.signal.aborted) throw new MigrationError('archive-layout', 'Migration preparation was interrupted.');
    throw new MigrationError('archive-layout', 'The protected archive or preparation directory could not be verified.');
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

function migrationApplication(config: NativeInstallationConfig, directory: FileHandle) {
  return {
    async stop() {
      if (!appListening(config.appPort, true)) return;
      await recordMigrationServiceResume(directory, config);
      systemctl('stop', app);
    },
    async restore() {
      if (!await hasMigrationServiceResume(directory, config)) return;
      if (!appListening(config.appPort, true)) await startApplication(config.appPort, { enableServices: false });
      await clearMigrationServiceResume(directory, config);
    },
  };
}

async function migrationPreflight(input: MigrationInput) {
  return withInstallationLock(async (owner) => {
    const config = readInstallationConfig(owner.appGroup);
    const restore = readRestoreIntent(owner.receipt);
    verifySetupFiles(config, readSetupIntent(owner.receipt), restore);
    if (!config || config.mode !== 'import' || restore)
      throw new MigrationError('target-setup', 'Complete import-mode setup on an inactive installation before migration preflight.');
    const client = await connectOwnedDatabase(config, owner.appGroup);
    try {
      const directory = await openNativeMigrationDirectory(true);
      const application = migrationApplication(config, directory);
      try {
        const db = client.db(databaseName);
        await assertMigrationTarget(db, config.installationId);
        const receipt = await inspectMigration(input, migrationOwner, await migrationConfig('postgres'),
          input.assetService !== undefined ? await migrationConfig('objects') : undefined);
        await checkMigrationCapacity(receipt.estimates);
        await application.stop();
        return await withStoppedWriter((writer) => publishMigrationPreflight(writer, db, config.installationId, input, receipt));
      } finally { try { await application.restore(); } finally { await directory.close(); } }
    } finally { await client.close(); }
  });
}

const migrationStageRequest = z.strictObject({ runId: publicIdSchema });

async function migrationStage(runId: string, statusOnly: boolean) {
  const run = async (owner: ReturnType<typeof verifyOwnership>) => {
    const config = readInstallationConfig(owner.appGroup);
    const restore = readRestoreIntent(owner.receipt);
    verifySetupFiles(config, readSetupIntent(owner.receipt), restore);
    if (!config || config.mode !== 'import' || restore) throw new MigrationError('target-setup', 'Select a protected import installation.');
    const client = await connectOwnedDatabase(config, owner.appGroup);
    try {
      const directory = await openNativeMigrationDirectory();
      const application = migrationApplication(config, directory);
      try {
        const db = client.db(databaseName);
        const saved = await readProtectedMigrationRun(db, config.installationId, directory, migrationOwner, runId);
        if (statusOnly) {
          const installed = await readInstallation(db, config.installationId);
          requireCurrentSchema(installed);
          const cutover = await inspectMigrationCutover(db, installed);
          const status = publicMigrationStatus(saved.run);
          const receipt = cutover?.binding.verification.runId === runId ? cutover : saved.run.rollback;
          return receipt ? { ...status, ...publicCutover(receipt), activeGenerationId: installed.activeGenerationId } : status;
        }
        await assertMigrationTarget(db, config.installationId);
        const source = await migrationConfig('postgres');
        const objects = saved.input.assetService === undefined ? undefined : await migrationConfig('objects');
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        try {
          await application.stop();
          return await withStoppedWriter((writer) => stageProtectedMigrationRun(db, writer, saved, migrationOwner, source, objects, {
            prepare: nativeMigrationMediaPublisher({ uid: owner.appUid, gid: owner.appGroup }, writer), signal: controller.signal,
          }));
        } catch (error) {
          if (controller.signal.aborted) throw new MigrationError('target-write', 'Migration staging was interrupted. Resume the same run.');
          throw error;
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        }
      } finally { try { if (!statusOnly) await application.restore(); } finally { await directory.close(); } }
    } finally { await client.close(); }
  };
  return statusOnly ? run(verifyOwnership()) : withInstallationLock(run);
}

const migrationVerificationRequest = z.strictObject({ runId: publicIdSchema, manifestSha256: migrationDigestSchema.optional(),
  page: z.strictObject({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(1000) }).optional() });

async function migrationVerification(runId: string, verify: boolean, manifestSha256?: string) {
  return withInstallationLock(async (owner) => {
    const config = readInstallationConfig(owner.appGroup);
    const restore = readRestoreIntent(owner.receipt);
    verifySetupFiles(config, readSetupIntent(owner.receipt), restore);
    if (!config || config.mode !== 'import' || restore) throw new MigrationError('target-setup', 'Select a protected import installation.');
    const client = await connectOwnedDatabase(config, owner.appGroup);
    try {
      const directory = await openNativeMigrationDirectory();
      const application = migrationApplication(config, directory);
      try {
        const db = client.db(databaseName);
        const { run, input, cursors } = await readProtectedMigrationRun(db, config.installationId, directory, migrationOwner, runId);
        if (manifestSha256 !== undefined && manifestSha256 !== run.manifestSha256)
          throw new MigrationError('source-changed', 'The expected manifest does not match the protected migration run.');
        if (!verify || run.state === 'verified' || run.state === 'blocked') return readMigrationVerification(directory, migrationOwner, run);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        try {
          await application.stop();
          return await withStoppedWriter(async (writer) => {
            const media = await openPrivateBlobVerifier(backupBlobs, { uid: owner.appUid, gid: owner.appGroup });
            try {
              const identity = { runId, installationId: run.installationId, generationId: run.generationId, fingerprint: run.fingerprint };
              const decode = createMediaDecoder(fileURLToPath(new URL('../../../../lib/decode-media.py', import.meta.url)),
                '/usr/bin/python3', { uid: owner.appUid, gid: owner.appGroup });
              const sourceConfig = await migrationConfig('postgres');
              const objectConfig = input.assetService !== undefined ? await migrationConfig('objects') : undefined;
              const { value: { report, verifying } } = await withNativeVerificationScratch(runId, (scratch) =>
                withMigrationSnapshot(input, migrationOwner, sourceConfig, objectConfig, {
                  expectedManifestSha256: run.manifestSha256, expectedFingerprint: run.fingerprint.sha256,
                },
                  async (snapshot) => {
                    controller.signal.throwIfAborted();
                    const verifying = await beginMigrationVerification(writer, db, run, snapshot, cursors);
                    const report = await collectMigrationVerification(db, writer, identity, snapshot, cursors,
                      { verifyBlob: media.verifyBlob, scratch, decode }, controller.signal);
                    return { report, verifying };
                  }));
              controller.signal.throwIfAborted();
              return await persistMigrationVerification(writer, db, directory, migrationOwner, verifying, report);
            } finally { await media.close(); }
          });
        } catch (error) {
          if (controller.signal.aborted) throw new MigrationError('verification-incomplete', 'Migration verification was interrupted.');
          throw error;
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        }
      } finally { try { if (verify) await application.restore(); } finally { await directory.close(); } }
    } finally { await client.close(); }
  });
}

async function bootstrapMigrationAdmin(input: ReturnType<typeof migrationAdminRequest.parse>) {
  return withInstallationLock(async (owner) => {
    const config = readInstallationConfig(owner.appGroup);
    const restore = readRestoreIntent(owner.receipt);
    verifySetupFiles(config, readSetupIntent(owner.receipt), restore);
    if (!config || config.mode !== 'import' || restore) throw new MigrationError('target-setup', 'Select a protected import installation.');
    const client = await connectOwnedDatabase(config, owner.appGroup);
    try {
      const directory = await openNativeMigrationDirectory();
      const application = migrationApplication(config, directory);
      try {
        const db = client.db(databaseName);
        const { run, cursors } = await readProtectedMigrationRun(db, config.installationId, directory, migrationOwner, input.runId);
        cursors.assertComplete(run);
        const report = await readMigrationVerification(directory, migrationOwner, run);
        if (report.summary.outcome !== 'verified') throw new MigrationError('target-setup', 'Select a verified inactive migration run.');
        await application.stop();
        return await withStoppedWriter((writer) => issueMigrationAdminRecovery(db, writer, run, input));
      } finally { try { await application.restore(); } finally { await directory.close(); } }
    } finally { await client.close(); }
  });
}

const activateRequest = z.strictObject({ runId: publicIdSchema, manifestSha256: migrationDigestSchema,
  approvalPath: z.custom<string>(migrationPath).optional() });
const rollbackRequest = z.strictObject({ generationId: generationIdSchema });
type CutoverRequest = { action: 'activate'; input: z.infer<typeof activateRequest> }
  | { action: 'enable'; input: z.infer<typeof migrationStageRequest> } | { action: 'rollback'; input: z.infer<typeof rollbackRequest> };

function publicCutover(receipt: MigrationActivationReceipt) {
  const { runId, generationId, manifestSha256, fingerprintSha256, reportSha256 } = receipt.binding.verification;
  return { runId, generationId, manifestSha256, fingerprintSha256, reportSha256, state: receipt.state,
    firstWriteFenced: receipt.state === 'writable' && receipt.fence !== undefined,
    activeGenerationId: receipt.state === 'rolledBack' ? receipt.binding.prior.generationId : generationId };
}

async function changeMigrationRoute(request: CutoverRequest) {
  return withInstallationLock(async (owner) => {
    const config = readInstallationConfig(owner.appGroup);
    const restore = readRestoreIntent(owner.receipt);
    verifySetupFiles(config, readSetupIntent(owner.receipt), restore);
    if (!config || config.mode !== 'import' || (restore && request.action !== 'enable')) {
      throw new MigrationError('target-setup', 'Select a protected import installation with the required activation history.');
    }
    const client = await connectOwnedDatabase(config, owner.appGroup);
    try {
      const directory = await openNativeMigrationDirectory();
      const application = migrationApplication(config, directory);
      try {
        await application.stop();
        return await withStoppedWriter(async (writer) => {
          const db = client.db(databaseName);
          const { installationId } = config;
          const installed = await verifyStorageSchema(db, installationId);
          const mfaKey = readNativeMfaKey(installationId, owner.appGroup);
          await assertNativeMfaKey(db, installationId, mfaKey);
          if (restore && request.action === 'enable') {
            return enableRestoredMigrationWrites(db, writer, installationId, request.input.runId, restore, mfaKey.digest);
          }
          const cutover = await inspectMigrationCutover(db, installed);
          if (request.action === 'rollback' && (!cutover || cutover.binding.verification.generationId !== request.input.generationId))
            throw new MigrationError('activation-conflict', 'Select the current or already rolled back imported generation.');
          const runId = request.action === 'rollback' ? cutover!.binding.verification.runId : request.input.runId;
          const { run, input, cursors } = await readProtectedMigrationRun(db, installationId, directory, migrationOwner, runId);
          cursors.assertComplete(run);
          if (request.action === 'rollback') return rollbackMigration(db, writer, installationId, request.input.generationId);
          if (request.action === 'enable') return enableMigrationWrites(db, writer, installationId, runId);
          const { verification, approval } = await prepareMigrationCutover(directory, migrationOwner, run,
            request.input.manifestSha256, request.input.approvalPath);
          const prior = run.activation?.prior ?? { generationId: installed.activeGenerationId, setup: installed.setup };
          if (prior.generationId !== null || !prior.setup)
            throw new MigrationError('activation-conflict', 'Native activation requires the original cold setup rollback point.');
          let administrator = run.activation?.administrator;
          if (!administrator) {
            const proof = await readMigrationAdminActivationProof(db, run);
            if (!proof) throw new MigrationError('activation-conflict', 'Complete the designated administrator recovery before activation.');
            const { userId, recoveryId, accountRevision, credentialsVersion, factorId } = proof;
            administrator = { userId, recoveryId, revision: accountRevision, credentialsVersion, factorId };
          }
          const activate = () => activateVerifiedMigration(db, writer, installationId, cursors,
            { verification, approval, administrator, prior: { ...prior, setup: prior.setup! }, mfaKeyDigest: mfaKey.digest });
          if (cutover?.binding.verification.runId === runId) return activate();
          const postgres = await migrationConfig('postgres');
          const objects = input.assetService !== undefined ? await migrationConfig('objects') : undefined;
          return (await withMigrationSnapshot(input, migrationOwner, postgres, objects, {
            expectedManifestSha256: run.manifestSha256, expectedFingerprint: run.fingerprint.sha256,
          }, activate)).value;
        });
      } finally { try { await application.restore(); } finally { await directory.close(); } }
    } finally { await client.close(); }
  });
}

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'package-remove' && args.length === 0) {
    await withInstallationLock(async () => {
      systemctl('stop', app);
      await withStoppedWriter(async () => {
        stopDatabase();
        systemctl('disable', app, database);
      });
    });
  } else if ((action === 'account-inspect' || action === 'account-confirm') && args.length === 2) {
    await handleAccountApproval(action === 'account-inspect' ? 'inspect' : 'confirm', publicIdSchema.parse(args[0]), args[1]);
  } else if ((action === 'migration-prepare' || action === 'migration-preflight')
      && args.length === 2 && (args[1] === 'text' || args[1] === 'json')) {
    if (action === 'migration-prepare') {
      const result = await prepareCapture(JSON.parse(args[0]));
      console.log(args[1] === 'json' ? JSON.stringify(result) : `Verified capture ${result.manifestSha256}. Restore ${result.dump} in the isolated PostgreSQL instance. Manifest ${result.manifest}.`);
    } else {
      const result = await migrationPreflight(parseMigrationInput(JSON.parse(args[0])));
      console.log(args[1] === 'json' ? JSON.stringify(result) : `Run ${result.runId} preflighted for manifest ${result.manifestSha256}. Missing originals ${result.assets.missingOriginals}, missing derivatives ${result.assets.missingDerivatives}.`);
    }
  } else if ((action === 'migration-stage' || action === 'migration-resume' || action === 'migration-status')
    && args.length === 2 && (args[1] === 'json' || args[1] === 'text')) {
    const { runId } = migrationStageRequest.parse(JSON.parse(args[0]));
    const result = await migrationStage(runId, action === 'migration-status');
    const progress = result.checkpoint ? ` Checkpoint ${result.checkpoint.pass}/${result.checkpoint.table}.` : '';
    console.log(args[1] === 'json' ? JSON.stringify(result)
      : `Run ${result.runId} is ${result.stageComplete && result.state === 'staging' ? 'staged' : result.state}.${progress}`);
  } else if ((action === 'migration-verify' || action === 'migration-report') && args.length === 2
      && (args[1] === 'json' || (action === 'migration-verify' && args[1] === 'text'))) {
    const request = migrationVerificationRequest.parse(JSON.parse(args[0]));
    const verify = action === 'migration-verify';
    if (verify && request.page) throw new MigrationError('verification-incomplete', 'Only a verification report accepts detail pagination.');
    const result = await migrationVerification(request.runId, verify, request.manifestSha256);
    const output = request.page ? migrationVerificationPage(result, request.page.offset, request.page.limit) : publicMigrationVerification(result);
    if (args[1] === 'json') console.log(JSON.stringify(output));
    else console.log(`Run ${result.summary.runId} ${result.summary.outcome}. Report ${result.reportSha256}. Missing originals ${result.summary.assets.missingOriginals}.`);
    if (verify && result.summary.outcome === 'blocked') process.exitCode = 1;
  } else if ((action === 'migration-activate' || action === 'migration-enable-writes' || action === 'migration-rollback')
    && args.length === 2 && (args[1] === 'text' || args[1] === 'json')) {
    const input: unknown = JSON.parse(args[0]);
    const request: CutoverRequest = action === 'migration-activate' ? { action: 'activate', input: activateRequest.parse(input) }
      : action === 'migration-enable-writes' ? { action: 'enable', input: migrationStageRequest.parse(input) }
      : { action: 'rollback', input: rollbackRequest.parse(input) };
    const result = publicCutover(await changeMigrationRoute(request));
    console.log(args[1] === 'json' ? JSON.stringify(result) : `Run ${result.runId} is ${result.state}.`);
  } else if (action === 'migration-bootstrap-admin' && args.length === 2 && (args[1] === 'text' || args[1] === 'json')) {
    const result = await bootstrapMigrationAdmin(migrationAdminRequest.parse(JSON.parse(args[0])));
    if (args[1] === 'json') console.log(JSON.stringify(result));
    else {
      console.log(`Administrator ${result.userId} recovery expires at ${result.expiresAt}.`);
      if (result.status === 'issued') {
        console.log('Give this grant privately to the designated administrator for /account-recovery.');
        console.log(result.grant);
      } else console.log('The grant was already issued. Use --rotate to replace an unused or incomplete grant.');
    }
  } else if (action === 'backup-create' && args.length === 1) {
    const result = await withInstallationLock(localBackupRequest);
    console.log(args[0] === 'json' ? JSON.stringify(result) : `Backup ${result.directory} verified with manifest ${result.manifestSha256}.`);
  } else if (action === 'backup-restore' && args.length === 2) {
    const result = await restoreBackup(parseRestoreOptions(JSON.parse(args[0])));
    console.log(args[1] === 'json' ? JSON.stringify(result) : `Backup ${result.manifestSha256} staged and verified.`);
  } else if (action === 'backup-activate' && args.length === 3 && args[1] === '--yes') {
    const result = await activateBackup(args[0]);
    console.log(args[2] === 'json' ? JSON.stringify(result) : `Restored generation ${result.generationId} activated. Sign in again.`);
  } else if (action === 'verify-storage' && args.length === 1) {
    const result = await verifyInstalledStorage();
    console.log(args[0] === 'json' ? JSON.stringify(result) : `Planner storage schema ${result.schemaVersion} verified.`);
  } else {
    const format = args.pop();
    let result: Awaited<ReturnType<typeof setup>>;
    if (action === 'setup' && args.length === 1) {
      result = await setup(nativeSetupOptions.parse(JSON.parse(args[0])));
    } else if (action === 'status' && args.length === 0) {
      result = await status(verifyOwnership());
    } else if ((action === 'start' || action === 'stop' || action === 'restart') && args.length === 0) {
      result = await control(action);
    } else {
      throw new NativeMongoError('Choose an installed Planner operator command.');
    }
    if (format === 'json') {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Planner ${result.version} is ${result.configuration}.`);
      console.log(`Application ${result.services.application}, database ${result.services.database}, readiness ${result.readiness}.`);
      console.log(`Setup mode is ${result.mode ?? 'undecided'}. Pending action is ${result.pendingAction}.`);
      if (result.firstAdminGrant) {
        console.log(`First-administrator enrollment grant expires at ${result.firstAdminGrant.expiresAt}.`);
        console.log(result.firstAdminGrant.token);
      }
    }
  }
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(process.argv.at(-1) === 'json' ? JSON.stringify({ fault: error.fault, message: error.message }) : error.message);
  } else console.error(error instanceof NativeMongoError || error instanceof BackupError || error instanceof StorageSchemaError || error instanceof WriterOwnershipError
    ? error.message : 'The Planner operator command could not be completed.');
  process.exitCode = 1;
}
