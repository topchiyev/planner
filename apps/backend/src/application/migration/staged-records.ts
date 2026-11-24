import { isDeepStrictEqual } from 'node:util';
import { MongoServerError, type Db, type Document } from 'mongodb';
import { checkAccountIdentity, AccountActionError } from '../auth/account-policy.js';
import type { AccountRecord } from '../auth/accounts.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { durable } from '../command-journal/records.js';
import type { WorkspaceCollection } from '../../storage/catalog.js';
import { legacyPublicId, workspaceKey } from '../../storage/identity.js';
import { verifyStorageSchema } from '../../storage/schema.js';
import { workspaceInsertFields, type WorkspaceFields } from '../../storage/scoped.js';
import type { ImportIdentity } from './checkpoint.js';
import { MigrationError } from './manifest.js';
import { sourceKey, type SourceTable } from './source-projections.js';

export type ImportedEntity = Exclude<SourceTable, 'internal_config' | 'storage_usage'>;
export type SourceTimes = { createdAt: string | null; updatedAt: string | null };
export type ImportOrder = { parent: string; position: number } | { parent: string; position: number | null; board: string; changedAt: string | null };
export type ImportOptionalReference = null | { sourceId: string; unresolved?: 'missing-source-record' };

export type ImportProvenance = SourceTimes & {
  listChangedAt?: string | null;
  dueDate?: string | null;
  previousListSourceId?: string | null;
  creatorSourceId?: string | null;
  sourceCommentCount?: number;
  stopwatchStartedAt?: string | null;
  coverReference?: ImportOptionalReference;
  backgroundReference?: ImportOptionalReference;
  backgroundType?: string | null;
  backgroundGradient?: string | null;
  unrecognizedGradient?: true;
  unsupportedPreferences?: string[];
};

export type ImportReference = { parent: string; kind?: string };

type ImportMap = {
  _id: string; id: string; generationId: string; entity: ImportedEntity; sourceId: string; sourceInstanceId: string;
  provenance: ImportProvenance; order?: ImportOrder; reference?: ImportReference;
};

type StageCollection = Exclude<WorkspaceCollection, 'auditEntries' | 'sessions' | 'recoveryGrants' | 'trustedDevices'
  | 'oauthArtifacts' | 'oauthConnections' | 'commands' | 'commandEffectBatches' | 'events' | 'importRuns' | 'importIds' | 'users'>;

type StoredRow = { _id: string; id: string; generationId: string } & Document;

/** A migration must resume its exact immutable data before any activation is possible. */
export async function openImportRecords(db: Db, lease: WriterLease, identity: ImportIdentity, sourceInstanceId: string) {
  lease.assertHeld();
  const { installationId, generationId } = identity;
  const installation = await verifyStorageSchema(db, installationId);
  if (installation.activeGenerationId === generationId || installation.setup?.enrollmentGenerationId === generationId) {
    throw new MigrationError('target-setup', 'The selected import generation is already available to users.');
  }
  lease.assertHeld();
  const ids = db.collection<ImportMap>('importIds');
  const key = (id: string) => ({ _id: workspaceKey(generationId, id), generationId, id });
  const publicId = (entity: ImportedEntity, id: string) => legacyPublicId(sourceInstanceId, entity, sourceKey(entity, id));

  async function insert(collection: WorkspaceCollection, id: string, fields: Document) {
    lease.assertHeld();
    const stored = { ...fields, ...key(id) };
    const rows = db.collection<StoredRow>(collection);
    try {
      await rows.insertOne(stored, durable);
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await rows.findOne(key(id), { promoteLongs: false });
      if (!isDeepStrictEqual(existing, stored)) {
        throw new MigrationError('target-write', 'The import would overwrite a different staged record or duplicate a unique identity.');
      }
    }
  }

  async function mapping(entity: ImportedEntity, sourceId: string) {
    lease.assertHeld();
    const id = publicId(entity, sourceId);
    const mapped = await ids.findOne({ ...key(id), entity, sourceId, sourceInstanceId });
    if (!mapped) return null;
    if (mapped.id !== id || mapped.generationId !== generationId || mapped.entity !== entity || mapped.sourceId !== sourceId
      || mapped.sourceInstanceId !== sourceInstanceId) {
      throw new MigrationError('target-write', 'The protected source mapping has an invalid identity.');
    }
    return mapped;
  }

  const resolve = async (entity: ImportedEntity, sourceId: string) => (await mapping(entity, sourceId))?.id ?? null;

  return {
    publicId,
    mapping,
    resolve,
    async require(entity: ImportedEntity, sourceId: string) {
      const id = await resolve(entity, sourceId);
      if (!id) throw new MigrationError('source-read', 'A required typed source reference is missing.');
      return id;
    },
    reserve(entity: ImportedEntity, sourceId: string, provenance: ImportProvenance, order?: ImportOrder, reference?: ImportReference) {
      return insert('importIds', publicId(entity, sourceId), { entity, sourceId, sourceInstanceId, provenance,
        ...(order && { order }), ...(reference && { reference }) });
    },
    write(collection: StageCollection, id: string, fields: WorkspaceFields) {
      return insert(collection, id, workspaceInsertFields(collection, fields, 1));
    },
    async writeAccount(id: string, fields: Omit<AccountRecord, '_id' | 'id' | 'generationId' | 'revision' | 'localAuth' | 'accountChange'>,
      updatedAt: Date | null) {
      lease.assertHeld();
      try {
        await checkAccountIdentity(db, generationId, fields, id);
      } catch (error) {
        if (!(error instanceof AccountActionError) || error.kind !== 'identity') throw error;
        throw new MigrationError('source-read', 'The source has a duplicate normalized account identity.');
      }
      return insert('users', id, { ...workspaceInsertFields('users', { ...fields, updatedAt }, 1),
        localAuth: { passwordVerifier: null, credentialsVersion: 1,
          mfa: fields.requiresMfaEnrollment ? 'enrollment-required' : 'none' } });
    },
  };
}

export type ImportRecords = Awaited<ReturnType<typeof openImportRecords>>;
