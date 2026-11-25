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
import { createWorkspaceAuthorization, WorkspaceAccessError } from '../workspace/authorization.js';
import { canonicalRow, createWorkspaceRecords, directBoardRole, equal, type WorkspaceRecordName, type WorkspaceRow } from '../workspace/records.js';
import type { ImportIdentity } from './checkpoint.js';
import { MigrationError } from './manifest.js';
import type { ImportMediaProvenance } from './media-stage.js';
import type { StoredAvatar } from '../media/records.js';
import type { SourceDiscussion } from './discussion-stage.js';
import { sourceKey, type SourceTable } from './source-projections.js';

export type ImportedEntity = Exclude<SourceTable, 'internal_config' | 'storage_usage'>;
export type SourceTimes = { createdAt: string | null; updatedAt: string | null };
export type ImportOrder = { parent: string; position: number; definitionOwnerInstance?: string } | { parent: string; position: number | null; board: string; changedAt: string | null };
export type ImportOptionalReference = null | { sourceId: string; unresolved?: 'missing-source-record' };

export type ImportProvenance = SourceTimes & {
  listChangedAt?: string | null;
  dueDate?: string | null;
  previousListSourceId?: string | null;
  creatorSourceId?: string | null;
  sourceCommentCount?: number;
  observedCommentCount?: number;
  stopwatchStartedAt?: string | null;
  coverReference?: ImportOptionalReference;
  backgroundReference?: ImportOptionalReference;
  backgroundType?: string | null;
  backgroundGradient?: string | null;
  unrecognizedGradient?: true;
  unsupportedPreferences?: string[];
  discussion?: SourceDiscussion;
  media?: ImportMediaProvenance;
  linkedTask?: { sourceCardId: string; name: string; completed: boolean; missingTarget: boolean };
};

export type ImportReference = { parent: string; kind?: string; templateSourceId?: string | null };

export type ImportMap = {
  _id: string; id: string; generationId: string; entity: ImportedEntity; sourceId: string; sourceInstanceId: string;
  provenance: ImportProvenance; order?: ImportOrder; reference?: ImportReference;
};

type StageCollection = Exclude<WorkspaceCollection, 'auditEntries' | 'sessions' | 'recoveryGrants' | 'trustedDevices'
  | 'oauthArtifacts' | 'oauthConnections' | 'commands' | 'commandEffectBatches' | 'events' | 'importRuns' | 'importIds' | 'users'>;

type StoredRow = { _id: string; id: string; generationId: string } & Document;
type VerifyRecords = { accept(collection: WorkspaceCollection, fields: Document): void };

function stagedMismatch() {
  return new MigrationError('verification-blocked', 'A staged record or provenance differs from the frozen source.');
}

/** A migration must resume its exact immutable data before any activation is possible. */
export async function openImportRecords(db: Db, lease: WriterLease, identity: ImportIdentity, sourceInstanceId: string,
  verify?: VerifyRecords) {
  lease.assertHeld();
  const { installationId, generationId } = identity;
  const installation = await verifyStorageSchema(db, installationId);
  if (installation.activeGenerationId === generationId || installation.setup?.enrollmentGenerationId === generationId) {
    throw new MigrationError('target-setup', 'The selected import generation is already available to users.');
  }
  lease.assertHeld();
  const ids = db.collection<ImportMap>('importIds');
  const staged = createWorkspaceRecords(db, generationId);
  const key = (id: string) => ({ _id: workspaceKey(generationId, id), generationId, id });
  const publicId = (entity: ImportedEntity, id: string) => legacyPublicId(sourceInstanceId, entity, sourceKey(entity, id));

  async function insert(collection: WorkspaceCollection, id: string, fields: Document) {
    lease.assertHeld();
    const stored = { ...fields, ...key(id) };
    const rows = db.collection<StoredRow>(collection);
    if (verify) {
      const lateProvenance = ['attachment', 'background_image', 'uploaded_file', 'user_account'].includes(fields.entity);
      const projection = collection === 'users' ? { avatarMedia: 0, avatarBlobDigest: 0 }
        : collection === 'importIds' && fields.entity === 'card' ? { 'provenance.observedCommentCount': 0 }
        : collection === 'importIds' && lateProvenance ? { 'provenance.media': 0 } : undefined;
      const actual = await rows.findOne(key(id), { projection, promoteLongs: false });
      if (!isDeepStrictEqual(actual, stored)) throw stagedMismatch();
      verify.accept(collection, fields);
      return;
    }
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
    get<K extends WorkspaceRecordName>(collection: K, id: string) {
      lease.assertHeld();
      return staged.get(collection, id);
    },
    async hasDirectBoardMembership(boardId: string, userId: string) {
      lease.assertHeld();
      return !!await staged.first('boardMembers', { boardId, userId,
        $expr: { $and: [canonicalRow(generationId), equal('boardId', boardId), equal('userId', userId), directBoardRole] } });
    },
    resolve,
    async reconcileCardCommentCount(sourceId: string) {
      const card = await mapping('card', sourceId);
      if (!card || !Number.isInteger(card.provenance.sourceCommentCount)) {
        throw new MigrationError('target-write', 'The staged source card comment count is unavailable.');
      }
      const observed = await ids.countDocuments({ generationId, sourceInstanceId, entity: 'comment',
        'provenance.discussion.cardSourceId': sourceId });
      if (!Number.isSafeInteger(observed)) throw new MigrationError('target-write', 'The source card has too many comments.');
      const previous = card.provenance.observedCommentCount;
      if (previous === observed) return;
      if (verify) throw stagedMismatch();
      if (previous !== undefined) throw new MigrationError('target-write', 'The staged source comment count changed.');
      lease.assertHeld();
      const saved = await ids.updateOne({ ...key(card.id), sourceId, sourceInstanceId, entity: 'card',
        'provenance.observedCommentCount': { $exists: false } }, { $set: { 'provenance.observedCommentCount': observed } }, durable);
      if (saved.matchedCount !== 1) throw new MigrationError('target-write', 'The staged source comment count could not be recorded.');
    },
    async recipientCanReadCard(recipient: WorkspaceRow<'users'>, card: WorkspaceRow<'cards'>) {
      lease.assertHeld();
      if (recipient.generationId !== generationId || recipient.disabledAt !== null || card.generationId !== generationId) return false;
      try {
        await createWorkspaceAuthorization(db, generationId, { id: recipient.id, role: recipient.role }).requireCard(card.id, card.boardId);
        return true;
      } catch (error) {
        if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404) throw error;
        return false;
      }
    },
    async recordMediaProvenance(entity: ImportedEntity, sourceId: string, media: ImportMediaProvenance) {
      const mapped = await mapping(entity, sourceId);
      if (!mapped) throw new MigrationError('target-write', 'The staged source media mapping is unavailable.');
      const previous = mapped.provenance.media;
      if (isDeepStrictEqual(previous, media)) return;
      if (verify) throw stagedMismatch();
      if (previous !== undefined) throw new MigrationError('target-write', 'The staged source media provenance changed.');
      lease.assertHeld();
      const saved = await ids.updateOne({ ...key(mapped.id), entity, sourceId, sourceInstanceId,
        'provenance.media': { $exists: false } }, { $set: { 'provenance.media': media } }, durable);
      if (saved.matchedCount !== 1) throw new MigrationError('target-write', 'The staged source media provenance could not be recorded.');
    },
    async stageAvatar(id: string, digest: string | null, media: NonNullable<StoredAvatar['avatarMedia']>) {
      lease.assertHeld();
      const users = db.collection<StoredAvatar>('users');
      const filter = { ...key(id), revision: 1 };
      const current = await users.findOne(filter, { projection: { avatarBlobDigest: 1, avatarMedia: 1 } });
      if (!current) throw new MigrationError('target-write', 'The staged avatar account is unavailable.');
      if (current.avatarBlobDigest === digest && isDeepStrictEqual(current.avatarMedia, media)) return;
      if (verify) throw stagedMismatch();
      if (current.avatarMedia !== undefined || current.avatarBlobDigest !== undefined)
        throw new MigrationError('target-write', 'The staged avatar association changed.');
      lease.assertHeld();
      const saved = await users.updateOne({ ...filter, avatarMedia: { $exists: false }, avatarBlobDigest: { $exists: false } },
        { $set: { avatarBlobDigest: digest, avatarMedia: media } }, durable);
      if (saved.matchedCount !== 1) throw new MigrationError('target-write', 'The staged avatar association could not be recorded.');
    },
    async assertNoAvatar(sourceId: string, id: string) {
      lease.assertHeld();
      const [row, mapped] = await Promise.all([
        db.collection<StoredAvatar>('users').findOne(key(id), { projection: { avatarMedia: 1, avatarBlobDigest: 1 } }),
        mapping('user_account', sourceId),
      ]);
      if (!row || !mapped || row.avatarMedia !== undefined || row.avatarBlobDigest !== undefined || mapped.provenance.media !== undefined)
        throw stagedMismatch();
    },
    async hasProjectManager(projectSourceId: string) {
      lease.assertHeld();
      const parent = sourceKey('project', projectSourceId);
      const row = await ids.findOne({ generationId, sourceInstanceId, entity: 'project_manager', 'reference.parent': parent });
      if (!row) return false;
      const canonical = await mapping('project_manager', row.sourceId);
      if (!canonical || canonical._id !== row._id || canonical.reference?.parent !== parent) {
        throw new MigrationError('target-write', 'The protected project manager mapping has an invalid identity.');
      }
      return true;
    },
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
