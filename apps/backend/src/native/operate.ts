import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  nativeSetupOptions, PLANNER_VERSION, type NativeInstallationConfig, type NativeSetupOptions,
} from '@planner/contracts';
import {
  checkDirectory, checkReceipt, ensureNativeMongo, inspectNativeMongo, packageAccount, readProtectedFile,
  stopNativeMongoBootstrap,
} from './mongo-host.js';
import { NativeMongoError, parseMongoCredentials } from './mongo-identity.js';
import { connectVerifiedNativeMongo, mongoCredentialFile } from './mongo-readiness.js';
import {
  createSetupIntent, pendingAction, persistSetup, publishInstallationConfig, readInstallationConfig,
  readSetupIntent, sameSetup,
} from './setup-state.js';

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
  command(preflight, ['database'], 'Planner native ownership checks failed.');
  checkDirectory(statePath, 0, 0, 0o711);
  return { receipt: checkReceipt(), appGroup: packageAccount('-g', 'planner') };
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

function stopServices() {
  systemctl('stop', app);
  systemctl('stop', database);
  stopNativeMongoBootstrap();
}

function ensureConfigMatches(
  config: NativeInstallationConfig | undefined, intent: ReturnType<typeof readSetupIntent>,
) {
  if (config && (!intent || !sameSetup(config, intent.options))) {
    throw new NativeMongoError('The Planner configuration has no matching setup intent.');
  }
}

function status(owner: ReturnType<typeof verifyOwnership>) {
  const config = readInstallationConfig(owner.appGroup);
  const intent = readSetupIntent(owner.receipt);
  ensureConfigMatches(config, intent);
  const serviceState = (unit: string) => {
    const state = systemctl('show', '--property=ActiveState', '--value', unit);
    return ['active', 'inactive', 'activating', 'deactivating', 'failed'].includes(state) ? state : 'unknown';
  };
  return {
    version: PLANNER_VERSION,
    configuration: config ? 'configured' : intent ? 'configuring' : 'unconfigured',
    mode: intent?.options.mode ?? null,
    pendingAction: config ? pendingAction(config.mode) : intent ? 'resume-setup' : 'setup',
    readiness: 'unavailable',
    services: { application: serviceState(app), database: serviceState(database) },
  };
}

async function setup(options: NativeSetupOptions) {
  return withInstallationLock(async (owner) => {
    const existing = readInstallationConfig(owner.appGroup);
    let intent = readSetupIntent(owner.receipt);
    ensureConfigMatches(existing, intent);
    if (intent && !sameSetup(intent.options, options)) {
      throw new NativeMongoError('Repeat setup with the originally selected mode, origin and ports.');
    }
    appListening(options.appPort, !!existing);
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
    const contents = readProtectedFile(mongoCredentialFile, owner.appGroup, 0o640);
    const credential = parseMongoCredentials(contents === undefined ? undefined : JSON.parse(contents));
    if (credential.installationId !== active.installationId || credential.port !== options.dbPort) {
      throw new NativeMongoError('The Planner database credential does not match the setup installation.');
    }
    const client = await connectVerifiedNativeMongo(credential);
    try {
      const grant = await persistSetup(client, active.installationId, intent);
      publishInstallationConfig({ formatVersion: 1, installationId: active.installationId, ...options }, owner.appGroup);
      await startApplication(options.appPort);
      return { ...status(owner), ...(grant && { firstAdminGrant: grant }) };
    } finally {
      await client.close();
    }
  });
}

async function control(action: 'start' | 'stop' | 'restart') {
  return withInstallationLock(async (owner) => {
    if (action === 'stop') {
      stopServices();
      return status(owner);
    }
    const config = readInstallationConfig(owner.appGroup);
    ensureConfigMatches(config, readSetupIntent(owner.receipt));
    if (!config) throw new NativeMongoError('Complete Planner setup before starting its services.');
    appListening(config.appPort, true);
    if (action === 'restart') stopServices();
    const active = await ensureNativeMongo(config.dbPort);
    if (active.installationId !== config.installationId) {
      throw new NativeMongoError('The Planner application and database installation identities do not match.');
    }
    await startApplication(config.appPort);
    return status(owner);
  });
}

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'package-remove' && args.length === 0) {
    await withInstallationLock(async () => {
      stopServices();
      systemctl('disable', app, database);
    });
  } else {
    const format = args.pop();
    let result: Awaited<ReturnType<typeof setup>>;
    if (action === 'setup' && args.length === 1) {
      result = await setup(nativeSetupOptions.parse(JSON.parse(args[0])));
    } else if (action === 'status' && args.length === 0) {
      result = status(verifyOwnership());
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
      console.log(`Pending operator action: ${result.pendingAction}.`);
      if (result.firstAdminGrant) {
        console.log(`First-administrator enrollment grant (expires ${result.firstAdminGrant.expiresAt}): ${result.firstAdminGrant.token}`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof NativeMongoError ? error.message : 'The Planner operator command could not be completed.');
  process.exitCode = 1;
}
