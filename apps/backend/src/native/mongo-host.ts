import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  NativeMongoError, parseMongoCredentials, passwordPattern, provisionMongoIdentity, uuidPattern, validMongoPort,
  type MongoCredentials,
} from './mongo-identity.js';
import { mongoCredentialFile, mongoRuntimeDirectory, mongoRuntimeSocket, verifyNativeMongo } from './mongo-readiness.js';

const configDirectory = '/etc/planner';
const stateDirectory = '/var/lib/planner';
const dataDirectory = join(stateDirectory, 'mongodb');
const bootstrapDirectory = join(dataDirectory, '.planner-bootstrap');
const socketPath = join(bootstrapDirectory, 'mongod.sock');
const bootstrapConfig = join(configDirectory, 'mongod-bootstrap.conf');
const pendingConfig = join(configDirectory, 'mongod-pending.conf');
const permanentConfig = join(configDirectory, 'mongod.conf');
const journalPath = join(configDirectory, 'mongodb-init.json');
const account = 'planner-mongodb';
const executable = '/opt/planner/current/runtime/mongodb/bin/mongod';
const permanentUnit = 'planner-mongodb.service';
const bootstrapUnit = 'planner-mongodb-bootstrap.service';

interface Journal {
  receipt: string;
  dataIdentity: string;
  credentials: MongoCredentials;
  phase: 'initial' | 'authorized' | 'provisioned';
  adminPassword?: string;
}

function command(executable: string, args: string[], message: string) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0) throw new NativeMongoError(message);
  return result.stdout.trim();
}

function optionalStat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export function checkDirectory(path: string, uid: number, gid: number, mode: number) {
  const info = optionalStat(path);
  if (!info?.isDirectory() || info.uid !== uid || info.gid !== gid || (info.mode & 0o7777) !== mode) {
    throw new NativeMongoError('Unexpected Planner database directory identity or permissions.');
  }
  return info;
}

export function readProtectedFile(path: string, gid: number, mode: number) {
  const info = optionalStat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== gid || (info.mode & 0o7777) !== mode) {
    throw new NativeMongoError('Unexpected Planner database file identity or permissions.');
  }
  return readFileSync(path, 'utf8');
}

function syncConfigDirectory() {
  const directory = openSync(configDirectory, constants.O_DIRECTORY | constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function writeProtectedFile(path: string, contents: string, gid: number, mode: number) {
  const temporary = join(configDirectory, `.mongodb-${randomUUID()}`);
  const file = openSync(temporary, constants.O_WRONLY | constants.O_EXCL | constants.O_CREAT, mode);
  try {
    try {
      fchownSync(file, 0, gid);
      fchmodSync(file, mode);
      writeFileSync(file, contents);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    syncConfigDirectory();
  } finally {
    if (optionalStat(temporary)) unlinkSync(temporary);
  }
}

function ensureProtectedFile(path: string, contents: string, gid: number, mode: number) {
  const existing = readProtectedFile(path, gid, mode);
  if (existing === undefined) writeProtectedFile(path, contents, gid, mode);
  else if (existing !== contents) throw new NativeMongoError('The Planner database configuration does not match this installation.');
}

export function fileJson(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

function readJournal(): Journal | undefined {
  const saved = readProtectedFile(journalPath, 0, 0o600);
  if (saved === undefined) return undefined;
  const journal = JSON.parse(saved) as Journal;
  if (!journal || typeof journal.receipt !== 'string' || typeof journal.dataIdentity !== 'string'
      || !['initial', 'authorized', 'provisioned'].includes(journal.phase)
      || (journal.phase === 'provisioned' ? journal.adminPassword !== undefined
        : typeof journal.adminPassword !== 'string' || !passwordPattern.test(journal.adminPassword))) {
    throw new NativeMongoError('The Planner database initialization journal is invalid.');
  }
  return { ...journal, credentials: parseMongoCredentials(journal.credentials) };
}

function saveJournal(journal: Journal) {
  writeProtectedFile(journalPath, fileJson(journal), 0, 0o600);
}

function units() {
  const systemctl = '/usr/bin/systemctl';
  function show(unit: string) {
    const result = spawnSync(systemctl, [
      'show', '-p', 'LoadState,MainPID,FragmentPath,DropInPaths,ActiveState,User,Group,Transient,ExecStart', unit,
    ], { encoding: 'utf8', timeout: 10_000 });
    const values = new Map(result.stdout?.trim().split('\n').map((line) => {
      const equals = line.indexOf('=');
      return [line.slice(0, equals), line.slice(equals + 1)];
    }));
    if (unit === bootstrapUnit && values.get('LoadState') === 'not-found') return 0;
    const expected = unit === permanentUnit
      ? `/usr/lib/systemd/system/${unit}` : `/run/systemd/transient/${unit}`;
    const config = unit === permanentUnit ? permanentConfig : bootstrapConfig;
    const start = `path=${executable} ; argv[]=${executable} --config ${config} ;`;
    if (result.status !== 0 || values.get('LoadState') !== 'loaded' || values.get('FragmentPath') !== expected
        || values.get('DropInPaths') !== '' || values.get('User') !== account || values.get('Group') !== account
        || !values.get('ExecStart')?.includes(start)
        || values.get('Transient') !== (unit === permanentUnit ? 'no' : 'yes')) {
      throw new NativeMongoError('The systemd Planner database unit has an unexpected definition.');
    }
    const pid = Number(values.get('MainPID'));
    if (!Number.isInteger(pid) || pid < 0 || (!pid && !['inactive', 'failed'].includes(values.get('ActiveState') ?? ''))) {
      throw new NativeMongoError('The Planner database service is in an unexpected state.');
    }
    return pid;
  }
  return {
    pid: show,
    start: () => command(systemctl, ['start', permanentUnit], 'Could not start the Planner database service.'),
    stopBootstrap: () => command(systemctl, ['stop', bootstrapUnit], 'Could not stop the temporary Planner database.'),
    startBootstrap: () => command('/usr/bin/systemd-run', [
      `--unit=${bootstrapUnit}`, '--collect', '--service-type=exec',
      `--uid=${account}`, `--gid=${account}`, `--working-directory=${dataDirectory}`,
      '--property=UMask=0077', '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
      '--property=ProtectHome=yes', '--property=PrivateTmp=yes', `--property=ReadWritePaths=${dataDirectory}`,
      executable, '--config', bootstrapConfig,
    ], 'Could not start the temporary Planner database.'),
  };
}

function assertProcess(pid: number, uid: number, unit: string, config: string) {
  try {
    const proc = `/proc/${pid}`;
    const arguments_ = readFileSync(join(proc, 'cmdline'), 'utf8').split('\0');
    const cgroups = readFileSync(join(proc, 'cgroup'), 'utf8').split('\n');
    if (pid > 0 && lstatSync(proc).uid === uid && realpathSync(join(proc, 'exe')) === realpathSync(executable)
        && arguments_.join('\0') === [executable, '--config', config, ''].join('\0')
        && cgroups.some((group) => group.endsWith(`/system.slice/${unit}`))) return;
  } catch {
    // A vanished or unreadable process cannot establish ownership.
  }
  throw new NativeMongoError('The Planner database process ownership could not be established.');
}

function assertPort(port: number, ownerPid = 0) {
  const listeners = command('/usr/bin/ss', ['-H', '-ltnp', `sport = :${port}`], 'Could not inspect local TCP listeners.');
  if (!ownerPid && !listeners) return;
  const line = listeners.split('\n');
  if (ownerPid && line.length === 1 && line[0].split(/\s+/u)[3] === `127.0.0.1:${port}`
      && line[0].includes(`pid=${ownerPid},`)) return;
  throw new NativeMongoError('The selected Planner database port is occupied by an unexpected listener.');
}

async function waitForListener(check: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 199) throw error;
      await delay(50);
    }
  }
}

function assertOwnedSocket(path: string, pid: number, uid: number) {
  const socket = optionalStat(path);
  if (!socket?.isSocket() || socket.uid !== uid) throw new NativeMongoError('The Planner database socket is unavailable.');
  const unixListeners = command('/usr/bin/ss', ['-H', '-lxnp'], 'Could not inspect local Unix listeners.');
  if (!unixListeners.split('\n').some(
    (line) => {
      const fields = line.split(/\s+/u);
      return fields[1] === 'LISTEN' && fields.includes(path) && line.includes(`pid=${pid},`);
    },
  )) throw new NativeMongoError('The Planner database socket ownership could not be established.');
}

function assertBootstrapSocket(pid: number, uid: number) {
  assertProcess(pid, uid, bootstrapUnit, bootstrapConfig);
  assertOwnedSocket(socketPath, pid, uid);
  const tcpListeners = command('/usr/bin/ss', ['-H', '-ltnp'], 'Could not inspect local TCP listeners.');
  if (tcpListeners.includes(`pid=${pid},`)) {
    throw new NativeMongoError('The temporary Planner database unexpectedly listens on TCP.');
  }
}

function mongodConfiguration(bindIp: string, port: number, localhostBypass: boolean, socketMode: number) {
  return fileJson({
    storage: { dbPath: dataDirectory },
    net: { bindIp, port, unixDomainSocket: { enabled: false, filePermissions: socketMode } },
    security: { authorization: 'enabled' },
    setParameter: { diagnosticDataCollectionEnabled: false, enableLocalhostAuthBypass: localhostBypass },
  });
}

export function packageAccount(option: '-u' | '-g', name: string) {
  return Number(command('/usr/bin/id', [option, name], 'The dedicated Planner service accounts must be provisioned.'));
}

export function checkReceipt() {
  const path = '.native-installation';
  const prefix = 'planner-workspace 1 ';
  const receipt = readProtectedFile(join(configDirectory, path), 0, 0o644);
  if (!receipt?.startsWith(prefix) || !uuidPattern.test(receipt.trim().slice(prefix.length))
      || receipt !== readProtectedFile(join(stateDirectory, path), 0, 0o644)) {
    throw new NativeMongoError('The native Planner installation receipts are missing or inconsistent.');
  }
  return receipt.trim().slice(prefix.length);
}

export async function ensureNativeMongo(port: number, restoreInstallationId?: string) {
  if (process.getuid?.() !== 0 || !validMongoPort(port)) {
    throw new NativeMongoError('Database initialization requires root and a valid private MongoDB port.');
  }
  const before = inspectNativeMongo(port);
  // The root-owned package directory is a stable inode across initialization and reinstall.
  const lock = openSync(configDirectory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const info = fstatSync(lock);
    if (info.ino !== before.config.ino || info.dev !== before.config.dev
        || spawnSync('/usr/bin/flock', ['-nx', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock] }).status !== 0) {
      throw new NativeMongoError('The Planner database initialization lock is unavailable.');
    }
    const state = inspectNativeMongo(port);
    if (info.ino !== state.config.ino || info.dev !== state.config.dev) {
      throw new NativeMongoError('The Planner configuration directory changed during initialization.');
    }
    return await provisionLocked(port, state, restoreInstallationId);
  } finally {
    closeSync(lock);
  }
}

export function stopNativeMongoBootstrap() {
  const unit = units();
  const pid = unit.pid(bootstrapUnit);
  if (!pid) return;
  assertProcess(pid, packageAccount('-u', account), bootstrapUnit, bootstrapConfig);
  unit.stopBootstrap();
}

export function inspectNativeMongo(port: number) {
  const preflight = fileURLToPath(new URL('../../../../lib/native-preflight', import.meta.url));
  command(preflight, ['database'], 'Planner native database ownership checks failed.');
  const config = checkDirectory(configDirectory, 0, 0, 0o711);
  const uid = packageAccount('-u', account);
  const gid = packageAccount('-g', account);
  const appGid = packageAccount('-g', 'planner');
  const receipt = checkReceipt();
  const data = checkDirectory(dataDirectory, uid, gid, 0o700);
  const dataIdentity = `${data.dev}:${data.ino}`;
  const unit = units();
  const journal = readJournal();
  if (journal && (journal.receipt !== receipt || journal.dataIdentity !== dataIdentity
      || journal.credentials.port !== port || journal.credentials.dbUid !== uid || journal.credentials.dbGid !== gid)) {
    throw new NativeMongoError('The Planner database journal belongs to a different installation, directory or port.');
  }
  const permanent = mongodConfiguration(`127.0.0.1,${mongoRuntimeSocket}`, port, false, 0o777);
  const existingConfig = readProtectedFile(permanentConfig, gid, 0o640);
  const permanentPid = unit.pid(permanentUnit);
  const bootstrapPid = unit.pid(bootstrapUnit);
  if (bootstrapPid) assertProcess(bootstrapPid, uid, bootstrapUnit, bootstrapConfig);
  if (permanentPid) {
    assertProcess(permanentPid, uid, permanentUnit, permanentConfig);
    assertPort(port, permanentPid);
    checkDirectory(mongoRuntimeDirectory, uid, gid, 0o711);
    assertOwnedSocket(mongoRuntimeSocket, permanentPid, uid);
  } else {
    assertPort(port);
    if (optionalStat(mongoRuntimeDirectory)) {
      throw new NativeMongoError('The Planner database runtime directory is already in use.');
    }
  }
  if ((permanentPid || existingConfig !== undefined)
      && (journal?.phase !== 'provisioned' || existingConfig !== permanent)) {
    throw new NativeMongoError('The active Planner database configuration does not match the journal.');
  }

  if (!journal && (readdirSync(dataDirectory).length || bootstrapPid
      || [mongoCredentialFile, pendingConfig, bootstrapConfig].some(optionalStat))) {
    throw new NativeMongoError('The uninitialized Planner database directory or configuration is already in use.');
  }
  return { config, uid, gid, appGid, receipt, dataIdentity, unit, journal, permanent, existingConfig, permanentPid };
}

async function provisionLocked(port: number, state: ReturnType<typeof inspectNativeMongo>, restoreInstallationId?: string) {
  const { uid, gid, appGid, receipt, dataIdentity, unit, permanent, existingConfig, permanentPid } = state;
  let { journal } = state;
  if (restoreInstallationId && journal && journal.credentials.installationId !== restoreInstallationId) {
    throw new NativeMongoError('The Planner database belongs to a different restore installation.');
  }
  if (!journal) {
    journal = {
      receipt, dataIdentity,
      credentials: {
        installationId: restoreInstallationId ?? randomUUID(), port, dbUid: uid, dbGid: gid, password: randomBytes(32).toString('hex'),
      },
      phase: 'initial', adminPassword: randomBytes(32).toString('hex'),
    };
    saveJournal(journal);
  }
  const credentials = journal.credentials;
  const appContents = fileJson(credentials);
  if (journal.phase === 'provisioned' && readProtectedFile(mongoCredentialFile, appGid, 0o640) !== appContents) {
    throw new NativeMongoError('The provisioned Planner database credential file does not match.');
  }
  ensureProtectedFile(mongoCredentialFile, appContents, appGid, 0o640);
  if (existingConfig === undefined) ensureProtectedFile(pendingConfig, permanent, gid, 0o640);

  const stopBootstrap = () => {
    const pid = unit.pid(bootstrapUnit);
    if (!pid) return;
    assertProcess(pid, uid, bootstrapUnit, bootstrapConfig);
    unit.stopBootstrap();
    if (unit.pid(bootstrapUnit)) throw new NativeMongoError('The temporary Planner database did not stop.');
  };

  if (journal.phase !== 'provisioned') {
    if (!optionalStat(bootstrapDirectory)) {
      mkdirSync(bootstrapDirectory, { mode: 0o700 });
    }
    // A crash between mkdir and chown can leave the empty root-created socket directory.
    const directory = openSync(bootstrapDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(directory);
      if (info.uid === 0 && info.gid === 0 && (info.mode & 0o7777) === 0o700) {
        fchownSync(directory, uid, gid);
      }
    } finally {
      closeSync(directory);
    }
    checkDirectory(bootstrapDirectory, uid, gid, 0o700);
    ensureProtectedFile(bootstrapConfig, mongodConfiguration(socketPath, 0, true, 0o700), gid, 0o640);
    try {
      if (!unit.pid(bootstrapUnit)) {
        assertPort(port);
        unit.startBootstrap();
      }
      await waitForListener(() => assertBootstrapSocket(unit.pid(bootstrapUnit), uid));
      const pending = journal;
      await provisionMongoIdentity(socketPath, credentials, pending.adminPassword!, pending.phase === 'initial', async () => {
        if (pending.phase === 'initial') {
          pending.phase = 'authorized';
          saveJournal(pending);
        }
      });
      delete pending.adminPassword;
      pending.phase = 'provisioned';
      saveJournal(pending);
    } finally {
      stopBootstrap();
    }
  } else {
    stopBootstrap();
  }

  if (readProtectedFile(bootstrapConfig, gid, 0o640) !== undefined) {
    unlinkSync(bootstrapConfig);
    syncConfigDirectory();
  }
  if (!permanentPid) {
    assertPort(port);
    if (existingConfig === undefined) {
      renameSync(pendingConfig, permanentConfig);
      syncConfigDirectory();
    }
    unit.start();
    await waitForListener(() => {
      const pid = unit.pid(permanentUnit);
      assertProcess(pid, uid, permanentUnit, permanentConfig);
      assertPort(port, pid);
      assertOwnedSocket(mongoRuntimeSocket, pid, uid);
    });
  }
  await verifyNativeMongo(credentials);
  return { installationId: credentials.installationId, dbPort: port };
}
