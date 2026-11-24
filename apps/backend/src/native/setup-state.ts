import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  nativeInstallationConfig, nativeSetupOptions, type NativeInstallationConfig, type NativeSetupOptions,
} from '@planner/contracts';
import type { MongoClient } from 'mongodb';
import { checkDirectory, fileJson, readProtectedFile, writeProtectedFile } from './mongo-host.js';
import { databaseName, NativeMongoError, uuidPattern } from './mongo-identity.js';

export const configPath = '/etc/planner/planner.json';
const intentPath = '/etc/planner/setup-intent.json';
const portsPath = '/etc/planner/native-ports';
const writeConcern = { w: 1, j: true };
const grantLifetimeMs = 30 * 60 * 1000;

interface FirstAdminGrant {
  id: string;
  generationId: string;
  token: string;
  expiresAt: number;
}

interface SetupIntent {
  receipt: string;
  options: NativeSetupOptions;
  grant?: FirstAdminGrant;
}

export function readInstallationConfig(appGroup: number) {
  checkDirectory('/etc/planner', 0, 0, 0o711);
  const contents = readProtectedFile(configPath, appGroup, 0o640);
  if (contents === undefined) return undefined;
  const result = nativeInstallationConfig.safeParse(JSON.parse(contents));
  if (!result.success) throw new NativeMongoError('The Planner application configuration is invalid.');
  return result.data;
}

export function readSetupIntent(receipt: string): SetupIntent | undefined {
  const contents = readProtectedFile(intentPath, 0, 0o600);
  if (contents === undefined) return undefined;
  const saved = JSON.parse(contents) as SetupIntent | null;
  const options = nativeSetupOptions.safeParse(saved?.options);
  if (saved?.receipt !== receipt || !options.success
      || (options.data.mode === 'fresh' ? !validGrant(saved.grant) : saved.grant !== undefined)) {
    throw new NativeMongoError('The Planner setup intent does not belong to this installation or is invalid.');
  }
  return { receipt, options: options.data, grant: saved.grant };
}

function validGrant(grant: FirstAdminGrant | undefined) {
  return !!grant && uuidPattern.test(grant.id) && uuidPattern.test(grant.generationId)
    && /^[A-Za-z0-9_-]{43}$/u.test(grant.token) && Number.isSafeInteger(grant.expiresAt);
}

export function sameSetup(first: NativeSetupOptions, second: NativeSetupOptions) {
  return first.mode === second.mode && first.publicUrl === second.publicUrl
    && first.appPort === second.appPort && first.dbPort === second.dbPort;
}

export function createSetupIntent(receipt: string, options: NativeSetupOptions): SetupIntent {
  const intent: SetupIntent = { receipt, options };
  if (options.mode === 'fresh') {
    intent.grant = {
      id: randomUUID(), generationId: randomUUID(),
      token: randomBytes(32).toString('base64url'), expiresAt: Date.now() + grantLifetimeMs,
    };
  }
  writeProtectedFile(intentPath, fileJson(intent), 0, 0o600);
  return intent;
}

export function publishInstallationConfig(config: NativeInstallationConfig, appGroup: number) {
  const existing = readInstallationConfig(appGroup);
  const ports = `${config.appPort} ${config.dbPort}\n`;
  const savedPorts = readProtectedFile(portsPath, 0, 0o600);
  if (savedPorts !== ports && (existing || savedPorts !== undefined)) {
    throw new NativeMongoError('The Planner package ports do not match the setup intent.');
  }
  if (savedPorts === undefined) writeProtectedFile(portsPath, ports, 0, 0o600);
  if (!existing) {
    writeProtectedFile(configPath, fileJson(config), appGroup, 0o640);
  } else if (existing.installationId !== config.installationId || !sameSetup(existing, config)) {
    throw new NativeMongoError('The Planner application configuration does not match the setup intent.');
  }
}

type PendingAction = 'first-admin-enrollment' | 'migration-preflight';

interface InstallationRecord {
  _id: string;
  installationId: string;
  activeGenerationId?: string | null;
  schemaVersion?: number;
  setup?: { mode: NativeSetupOptions['mode']; pendingAction: PendingAction; enrollmentGenerationId: string | null };
}

interface GrantRecord {
  _id: string;
  installationId: string;
  generationId: string;
  kind: 'first-admin';
  tokenDigest: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export function pendingAction(mode: NativeSetupOptions['mode']): PendingAction {
  return mode === 'fresh' ? 'first-admin-enrollment' : 'migration-preflight';
}

export async function persistSetup(client: MongoClient, installationId: string, intent: SetupIntent) {
  const database = client.db(databaseName);
  const installation = database.collection<InstallationRecord>('installation');
  const key = { _id: 'installation', installationId };
  const setup = {
    mode: intent.options.mode, pendingAction: pendingAction(intent.options.mode),
    enrollmentGenerationId: intent.grant?.generationId ?? null,
  };
  await installation.updateOne(
    { ...key, setup: { $exists: false }, activeGenerationId: { $exists: false } },
    { $set: { setup, activeGenerationId: null, schemaVersion: 0 } }, { writeConcern },
  );
  const stored = await installation.findOne(key);
  if (stored?.activeGenerationId !== null || stored.schemaVersion !== 0
      || stored.setup?.mode !== setup.mode || stored.setup.pendingAction !== setup.pendingAction
      || stored.setup.enrollmentGenerationId !== setup.enrollmentGenerationId) {
    throw new NativeMongoError('The database setup state does not match this installation.');
  }
  if (!intent.grant) return undefined;

  const grant = intent.grant;
  const recoveryGrants = database.collection<GrantRecord>('recoveryGrants');
  const digest = createHash('sha256').update(grant.token).digest('hex');
  await recoveryGrants.updateOne({ _id: grant.id }, { $setOnInsert: {
    installationId, generationId: grant.generationId, kind: 'first-admin',
    tokenDigest: digest, expiresAt: new Date(grant.expiresAt), consumedAt: null,
  } }, { upsert: true, writeConcern });
  const saved = await recoveryGrants.findOne({ _id: grant.id });
  if (saved?.installationId !== installationId || saved.generationId !== grant.generationId
      || saved.kind !== 'first-admin' || saved.tokenDigest !== digest || saved.expiresAt?.getTime() !== grant.expiresAt) {
    throw new NativeMongoError('The first-administrator grant does not match the durable setup intent.');
  }
  if (saved.consumedAt !== null || Date.now() >= grant.expiresAt) return undefined;
  return { token: grant.token, expiresAt: saved.expiresAt.toISOString() };
}
