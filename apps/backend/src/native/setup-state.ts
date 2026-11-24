import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  nativeInstallationConfig, nativeSetupOptions, type NativeInstallationConfig, type NativeSetupOptions,
} from '@planner/contracts/native';
import type { MongoClient } from 'mongodb';
import { workspaceKey } from '../storage/identity.js';
import { currentStorageSchema, type InstallationDocument } from '../storage/schema.js';
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
}

interface SetupIntent {
  receipt: string;
  options: NativeSetupOptions;
  createdAt: number;
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
  if (saved?.receipt !== receipt || !options.success || !Number.isSafeInteger(saved.createdAt) || saved.createdAt <= 0
      || (options.data.mode === 'fresh' ? !validGrant(saved.grant) : saved.grant !== undefined)) {
    throw new NativeMongoError('The Planner setup intent does not belong to this installation or is invalid.');
  }
  return { receipt, options: options.data, createdAt: saved.createdAt, grant: saved.grant };
}

function validGrant(grant: FirstAdminGrant | undefined) {
  return !!grant && uuidPattern.test(grant.id) && uuidPattern.test(grant.generationId)
    && /^[A-Za-z0-9_-]{43}$/u.test(grant.token);
}

export function sameSetup(first: NativeSetupOptions, second: NativeSetupOptions) {
  return first.mode === second.mode && first.publicUrl === second.publicUrl
    && first.appPort === second.appPort && first.dbPort === second.dbPort;
}

export function createSetupIntent(receipt: string, options: NativeSetupOptions): SetupIntent {
  const intent: SetupIntent = { receipt, options, createdAt: Date.now() };
  if (options.mode === 'fresh') {
    intent.grant = {
      id: randomUUID(), generationId: randomUUID(),
      token: randomBytes(32).toString('base64url'),
    };
  }
  writeProtectedFile(intentPath, fileJson(intent), 0, 0o600);
  return intent;
}

function packagePorts(options: NativeSetupOptions) {
  return `${options.appPort} ${options.dbPort}\n`;
}

export function checkPackagePorts(options: NativeSetupOptions | undefined, configured: boolean) {
  const saved = readProtectedFile(portsPath, 0, 0o600);
  if (saved === undefined && !configured) return false;
  if (!options || saved !== packagePorts(options)) {
    throw new NativeMongoError('The Planner package ports do not match the setup intent.');
  }
  return true;
}

export function publishInstallationConfig(config: NativeInstallationConfig, appGroup: number) {
  const existing = readInstallationConfig(appGroup);
  if (!checkPackagePorts(config, !!existing)) writeProtectedFile(portsPath, packagePorts(config), 0, 0o600);
  if (!existing) {
    writeProtectedFile(configPath, fileJson(config), appGroup, 0o640);
  } else if (existing.installationId !== config.installationId || !sameSetup(existing, config)) {
    throw new NativeMongoError('The Planner application configuration does not match the setup intent.');
  }
}

type PendingAction = 'first-admin-enrollment' | 'migration-preflight';

interface GrantRecord {
  _id: string;
  id: string;
  installationId: string;
  generationId: string;
  kind: 'first-admin';
  tokenDigest: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export function pendingAction(mode: NativeSetupOptions['mode']): PendingAction {
  return mode === 'fresh' ? 'first-admin-enrollment' : 'migration-preflight';
}

export async function persistSetup(client: MongoClient, installationId: string, intent: SetupIntent) {
  const database = client.db(databaseName);
  const installation = database.collection<InstallationDocument>('installation');
  const key = { _id: 'installation', installationId } as const;
  const setup = {
    mode: intent.options.mode, pendingAction: pendingAction(intent.options.mode),
    enrollmentGenerationId: intent.grant?.generationId ?? null,
  };
  await installation.updateOne(
    { ...key, setup: { $exists: false }, activeGenerationId: { $exists: false } },
    { $set: { setup, activeGenerationId: null, schemaVersion: 0 } }, { writeConcern },
  );
  const stored = await installation.findOne(key);
  if (stored?.activeGenerationId !== null || (stored.schemaVersion !== 0 && stored.schemaVersion !== currentStorageSchema)
      || stored.schemaMigration !== undefined
      || stored.setup?.mode !== setup.mode || stored.setup.pendingAction !== setup.pendingAction
      || stored.setup.enrollmentGenerationId !== setup.enrollmentGenerationId) {
    throw new NativeMongoError('The database setup state does not match this installation.');
  }
  if (!intent.grant) return undefined;

  const grant = intent.grant;
  const keyForGrant = workspaceKey(grant.generationId, grant.id);
  const recoveryGrants = database.collection<GrantRecord>('recoveryGrants');
  const digest = createHash('sha256').update(grant.token).digest('hex');
  const firstIssuedAt = stored.setup.firstAdminGrantIssuedAt;
  if (firstIssuedAt === undefined) {
    const issuedAt = new Date();
    await recoveryGrants.updateOne({ _id: keyForGrant }, { $setOnInsert: {
      id: grant.id, installationId, generationId: grant.generationId, kind: 'first-admin',
      tokenDigest: digest, issuedAt, expiresAt: new Date(issuedAt.getTime() + grantLifetimeMs), consumedAt: null,
    } }, { upsert: true, writeConcern });
  } else if (!(firstIssuedAt instanceof Date) || !Number.isFinite(firstIssuedAt.getTime())) {
    throw new NativeMongoError('The first-administrator grant issuance record is invalid.');
  }
  const saved = await recoveryGrants.findOne({ _id: keyForGrant });
  // The installation retains the issuance marker even after an expired or consumed grant is removed.
  if (!saved && firstIssuedAt !== undefined) return undefined;
  if (saved?.installationId !== installationId || saved.id !== grant.id || saved.generationId !== grant.generationId
      || saved.kind !== 'first-admin' || saved.tokenDigest !== digest
      || !(saved.issuedAt instanceof Date) || !(saved.expiresAt instanceof Date)
      || saved.expiresAt.getTime() - saved.issuedAt.getTime() !== grantLifetimeMs
      || (firstIssuedAt !== undefined && saved.issuedAt.getTime() !== firstIssuedAt.getTime())) {
    throw new NativeMongoError('The first-administrator grant does not match the durable setup intent.');
  }
  if (firstIssuedAt === undefined) {
    const marker = await installation.updateOne(
      { ...key, 'setup.firstAdminGrantIssuedAt': { $exists: false } },
      { $set: { 'setup.firstAdminGrantIssuedAt': saved.issuedAt } }, { writeConcern },
    );
    if (marker.matchedCount !== 1) throw new NativeMongoError('Could not retain the first-administrator grant issuance.');
  }
  if (saved.consumedAt !== null || Date.now() >= saved.expiresAt.getTime()) return undefined;
  return { token: grant.token, expiresAt: saved.expiresAt.toISOString() };
}
