import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { get, request as localRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { accountApprovalResultSchema, accountApprovalSchema, PLANNER_VERSION } from '@planner/contracts';
import {
  nativeSetupOptions, type NativeInstallationConfig, type NativeSetupOptions,
} from '@planner/contracts/native';
import { publicIdSchema } from '@planner/contracts/storage';
import type { MongoClient } from 'mongodb';
import { firstAdminBinding } from '../application/auth/first-admin.js';
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
import { assertNativeMfaKey, ensureNativeMfaKey, readNativeMfaKey } from './mfa-key.js';
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

function validateNativePorts({ appPort, dbPort }: NativeSetupOptions) {
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

async function startApplication(port: number) {
  systemctl('start', app);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (appListening(port, true)) {
      systemctl('enable', database, app);
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
  config: NativeInstallationConfig | undefined, intent: ReturnType<typeof readSetupIntent>,
) {
  if (config && (!intent || !sameSetup(config, intent.options))) {
    throw new NativeMongoError('The Planner configuration has no matching setup intent.');
  }
  checkPackagePorts(intent?.options, !!config);
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
  verifySetupFiles(config, intent);
  const serviceState = (unit: string) => {
    const state = systemctl('show', '--property=ActiveState', '--value', unit);
    return ['active', 'inactive', 'activating', 'deactivating', 'failed'].includes(state) ? state : 'unknown';
  };
  const services = { application: serviceState(app), database: serviceState(database) };
  const access = config && services.application === 'active' ? await appAccess(owner) : undefined;
  const ready = access?.kind === 'ready';
  let action: string;
  if (!config) action = intent ? 'resume-setup' : 'setup';
  else if (ready || confirmed) action = 'complete';
  else if (confirmed === false || access?.kind === 'enrollment'
      || (access?.kind === 'unavailable' && access.reason === 'migration')) action = pendingAction(config.mode);
  else action = (services.database === 'active' ? await storedPendingAction(config, owner.appGroup) : undefined) ?? 'unknown';
  return {
    version: PLANNER_VERSION,
    configuration: config ? 'configured' : intent ? 'configuring' : 'unconfigured',
    mode: intent?.options.mode ?? null,
    pendingAction: action,
    readiness: ready ? 'ready' : 'unavailable',
    services,
  };
}

async function setup(options: NativeSetupOptions) {
  validateNativePorts(options);
  return withInstallationLock(async (owner) => {
    const existing = readInstallationConfig(owner.appGroup);
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
      systemctl('stop', app);
      await withStoppedWriter(async () => stopDatabase());
      return status(owner);
    }
    const config = readInstallationConfig(owner.appGroup);
    verifySetupFiles(config, readSetupIntent(owner.receipt));
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
    return status(owner);
  });
}

async function verifyInstalledStorage() {
  const owner = verifyOwnership();
  const config = readInstallationConfig(owner.appGroup);
  verifySetupFiles(config, readSetupIntent(owner.receipt));
  if (!config) throw new NativeMongoError('Complete Planner setup before verifying its storage.');
  const client = await connectOwnedDatabase(config, owner.appGroup);
  try {
    const result = await verifyStorageSchema(client.db(databaseName), config.installationId);
    return { schemaVersion: result.schemaVersion, activeGeneration: result.activeGenerationId !== null };
  } finally {
    await client.close();
  }
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
  console.error(error instanceof NativeMongoError || error instanceof StorageSchemaError || error instanceof WriterOwnershipError
    ? error.message : 'The Planner operator command could not be completed.');
  process.exitCode = 1;
}
