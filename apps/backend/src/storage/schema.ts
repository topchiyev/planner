import { isDeepStrictEqual } from 'node:util';
import {
  generationIdSchema, installationIdSchema, normalizedEmailSchema, parseSourceIdentity, publicIdSchema, revisionSchema,
} from '@planner/contracts/storage';
import { MongoServerError, type Db, type Filter } from 'mongodb';
import { ownedIndexes, workspaceCollections, type OwnedIndex, type WorkspaceCollection } from './catalog.js';
import { isStoredDate, readLongField, readStoredInstant, signedLongFields, storedInstantFields, workspaceKey } from './identity.js';

export const currentStorageSchema = 1;
const writeConcern = { w: 1, j: true };

type MigrationPhase = 'records' | 'indexes' | 'verified';
interface MigrationProgress {
  from: 0;
  to: typeof currentStorageSchema;
  activeGenerationId: string | null;
  phase: MigrationPhase;
}

export interface InstallationDocument {
  _id: 'installation';
  installationId: string;
  activeGenerationId: string | null;
  schemaVersion: number;
  mfaKeyDigest?: string;
  schemaMigration?: MigrationProgress;
  setup?: {
    mode: 'fresh' | 'import';
    pendingAction: 'first-admin-enrollment' | 'migration-preflight' | 'complete';
    enrollmentGenerationId: string | null;
    firstAdminGrantIssuedAt?: Date;
  };
}

interface WorkspaceIdentity {
  _id: string;
  id?: string;
  generationId: string;
  normalizedEmail?: unknown;
  normalizedUsername?: unknown;
  [field: string]: unknown;
}

interface LegacyGrant extends WorkspaceIdentity {
  installationId: string;
  kind: string;
  tokenDigest: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface MigrationTestHooks {
  afterLegacyGrantCopy?: () => Promise<void>;
  beforeVersionPublication?: () => Promise<void>;
}

export class StorageSchemaError extends Error {
  constructor(readonly code: 'identity' | 'version' | 'catalog' | 'records' | 'migration', message: string) {
    super(message);
  }
}

export async function readInstallation(database: Db, installationId: string) {
  const expected = installationIdSchema.parse(installationId);
  const [record, extra] = await database.collection<InstallationDocument>('installation').find({}, { limit: 2 }).toArray();
  if (!record || extra || record._id !== 'installation' || record.installationId !== expected
      || (record.activeGenerationId !== null && !generationIdSchema.safeParse(record.activeGenerationId).success)) {
    throw new StorageSchemaError('identity', 'The workspace installation identity or generation is unavailable.');
  }
  return record;
}

export function requireCurrentSchema(installation: InstallationDocument) {
  if (installation.schemaVersion !== currentStorageSchema || installation.schemaMigration !== undefined) {
    throw new StorageSchemaError('version', 'The workspace storage schema is unavailable.');
  }
}

function catalogFailure(collection: WorkspaceCollection) {
  return new StorageSchemaError('catalog', `The stored catalog for ${collection} does not match the Planner schema.`);
}

async function checkCollection(database: Db, name: WorkspaceCollection, create: boolean) {
  const query = () => database.listCollections({ name }, { nameOnly: false }).next();
  let description = await query();
  if (!description && create) {
    try { await database.createCollection(name, { writeConcern }); }
    catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
    }
    description = await query();
  }
  if (description?.type !== 'collection' || Object.keys(description.options ?? {}).length !== 0) {
    throw catalogFailure(name);
  }
}

function compareIndex(expected: OwnedIndex, actual: Record<string, unknown>, idIndex = false) {
  const { name, key, unique, partialFilterExpression, v, ns, ...other } = actual;
  return name === expected.name && v === 2 && (ns === undefined || typeof ns === 'string')
    && !!key && typeof key === 'object' && isDeepStrictEqual(Object.entries(key), expected.keys)
    && (idIndex ? unique === undefined || unique === true : unique === expected.unique)
    && isDeepStrictEqual(partialFilterExpression, expected.partialFilterExpression)
    && Object.keys(other).length === 0;
}

async function missingIndexes(database: Db, name: WorkspaceCollection, complete: boolean) {
  const idIndex: OwnedIndex = { name: '_id_', keys: [['_id', 1]] };
  const expected = new Map([idIndex, ...ownedIndexes(name)].map((index) => [index.name, index]));
  const actual = await database.collection(name).listIndexes().toArray();
  for (const index of actual) {
    const definition = expected.get(index.name);
    if (!definition || !compareIndex(definition, index, index.name === '_id_')) throw catalogFailure(name);
    expected.delete(index.name);
  }
  if (expected.has('_id_') || (complete && expected.size)) throw catalogFailure(name);
  return [...expected.values()];
}

async function verifyCatalog(database: Db) {
  await Promise.all(workspaceCollections.map(async (name) => {
    await checkCollection(database, name, false);
    await missingIndexes(database, name, true);
  }));
}

export async function verifyStorageSchema(database: Db, installationId: string) {
  requireCurrentSchema(await readInstallation(database, installationId));
  await verifyCatalog(database);
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  return installation;
}

async function moveLegacyGrants(database: Db, installation: InstallationDocument, hooks: MigrationTestHooks) {
  const collection = database.collection<LegacyGrant>('recoveryGrants');
  for await (const grant of collection.find({}, { promoteLongs: false })) {
    if (!publicIdSchema.safeParse(grant._id).success) continue;
    const issued = installation.setup?.firstAdminGrantIssuedAt;
    if (installation.setup?.mode !== 'fresh' || grant.kind !== 'first-admin'
        || grant.installationId !== installation.installationId
        || grant.generationId !== installation.setup.enrollmentGenerationId
        || (grant.id !== undefined && grant.id !== grant._id)
        || typeof grant.tokenDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(grant.tokenDigest)
        || !isStoredDate(grant.issuedAt) || !isStoredDate(grant.expiresAt)
        || grant.expiresAt.getTime() - grant.issuedAt.getTime() !== 30 * 60 * 1000
        || (issued !== undefined && (!isStoredDate(issued) || issued.getTime() !== grant.issuedAt.getTime()))
        || (grant.consumedAt !== null && !isStoredDate(grant.consumedAt))) {
      throw new StorageSchemaError('records', 'A legacy enrollment grant has an unexpected identity or shape.');
    }
    const id = grant._id;
    const { _id, ...fields } = { ...grant, id, _id: workspaceKey(grant.generationId, id) };
    const counterpart = { _id, ...fields };
    await collection.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true, writeConcern });
    const saved = await collection.findOne({ _id }, { promoteLongs: false });
    if (!saved || !isDeepStrictEqual(saved, counterpart)) {
      throw new StorageSchemaError('records', 'The canonical enrollment grant conflicts with the legacy record.');
    }
    await hooks.afterLegacyGrantCopy?.();
    const removed = await collection.deleteOne({
      _id: id, installationId: grant.installationId, generationId: grant.generationId, tokenDigest: grant.tokenDigest,
      kind: grant.kind, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
      consumedAt: grant.consumedAt === null ? { $type: 'null' } : grant.consumedAt,
      id: grant.id === undefined ? { $exists: false } : grant.id,
    }, { writeConcern });
    if (removed.deletedCount !== 1) {
      throw new StorageSchemaError('records', 'The legacy enrollment grant changed during migration.');
    }
  }
}

async function verifyWorkspaceRecords(database: Db) {
  for (const name of workspaceCollections) {
    const collection = database.collection<WorkspaceIdentity>(name);
    const projection = { _id: 1, generationId: 1, id: 1, revision: 1,
      ...Object.fromEntries([...signedLongFields, ...storedInstantFields].map((field) => [field, 1])),
      ...(name === 'users' && { normalizedEmail: 1, normalizedUsername: 1 }),
      ...(name === 'importIds' && { entity: 1, sourceId: 1 }) };
    const keys = collection.find({}, { projection, promoteLongs: false });
    for await (const key of keys) {
      if (!generationIdSchema.safeParse(key.generationId).success || !publicIdSchema.safeParse(key.id).success
          || key._id !== workspaceKey(key.generationId, key.id!)) {
        throw new StorageSchemaError('records', `A stored ${name} identifier has an unexpected generation or shape.`);
      }
      if (name === 'users' && (!normalizedEmailSchema.safeParse(key.normalizedEmail).success
          || (key.normalizedUsername != null && typeof key.normalizedUsername !== 'string'))) {
        throw new StorageSchemaError('records', 'A stored normalized user identifier is not a concrete string.');
      }
      if (name === 'importIds') {
        try { parseSourceIdentity(key.entity, key.sourceId); }
        catch { throw new StorageSchemaError('records', 'A stored source mapping has an invalid source identity.'); }
      }
      if ('revision' in key && !revisionSchema.safeParse(key.revision).success) {
        throw new StorageSchemaError('records', `A stored ${name} revision is invalid.`);
      }
      for (const field of signedLongFields) {
        if (!(field in key)) continue;
        try { readLongField(field, key[field]); }
        catch {
          throw new StorageSchemaError('records', `A stored ${name} rank or sequence is not a signed BSON Long.`);
        }
      }
      for (const field of storedInstantFields) {
        if (!(field in key)) continue;
        try { readStoredInstant(key[field]); }
        catch { throw new StorageSchemaError('records', `A stored ${name} instant is not a BSON Date or null.`); }
      }
    }
  }
}

export async function migrateStorageSchema(database: Db, installationId: string, hooks: MigrationTestHooks = {}) {
  const record = await readInstallation(database, installationId);
  if (record.schemaVersion === currentStorageSchema) return verifyStorageSchema(database, installationId);
  if (record.schemaVersion !== 0) {
    throw new StorageSchemaError('version', 'The existing workspace schema cannot be upgraded by this release.');
  }
  const installation = database.collection<InstallationDocument>('installation');
  const key = { _id: record._id, installationId, schemaVersion: 0, activeGenerationId: record.activeGenerationId };
  const phases: MigrationPhase[] = ['records', 'indexes', 'verified'];
  const progress = (phase: MigrationPhase): MigrationProgress =>
    ({ from: 0, to: currentStorageSchema, activeGenerationId: record.activeGenerationId, phase });
  let phase = record.schemaMigration?.phase ?? 'records';
  if (record.schemaMigration !== undefined
      && (!phases.includes(phase) || !isDeepStrictEqual(record.schemaMigration, progress(phase)))) {
    throw new StorageSchemaError('migration', 'The existing workspace schema migration marker is incompatible.');
  }
  const atPhase = (expectedPhase: MigrationPhase): Filter<InstallationDocument> => ({ ...key, schemaMigration: progress(expectedPhase) });
  const requireMatch = (matched: number) => {
    if (matched !== 1) throw new StorageSchemaError('migration', 'Workspace installation state changed during schema migration.');
  };
  if (!record.schemaMigration) {
    const started = await installation.updateOne({ ...key, schemaMigration: { $exists: false } },
      { $set: { schemaMigration: progress(phase) } }, { writeConcern });
    requireMatch(started.matchedCount);
  }

  if (phase === 'records') {
    for (const name of workspaceCollections) {
      await checkCollection(database, name, true);
      await missingIndexes(database, name, false);
    }
    await moveLegacyGrants(database, record, hooks);
    const staged = await installation.updateOne(atPhase('records'),
      { $set: { schemaMigration: progress('indexes') } }, { writeConcern });
    requireMatch(staged.matchedCount);
    phase = 'indexes';
  }
  await verifyWorkspaceRecords(database);
  if (phase === 'indexes') {
    for (const name of workspaceCollections) {
      await checkCollection(database, name, false);
      const collection = database.collection(name, { writeConcern });
      for (const { name: indexName, keys, ...options } of await missingIndexes(database, name, false)) {
        await collection.createIndex(keys, { name: indexName, ...options });
      }
    }
  }
  await verifyCatalog(database);
  if (phase === 'indexes') {
    const validated = await installation.updateOne(atPhase('indexes'),
      { $set: { schemaMigration: progress('verified') } }, { writeConcern });
    requireMatch(validated.matchedCount);
  }
  await hooks.beforeVersionPublication?.();
  const published = await installation.updateOne(atPhase('verified'),
    { $set: { schemaVersion: currentStorageSchema }, $unset: { schemaMigration: '' } }, { writeConcern });
  requireMatch(published.matchedCount);
  return readInstallation(database, installationId);
}
