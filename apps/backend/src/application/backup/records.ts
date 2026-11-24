import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import { BSON, type Db, type Document } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { checkCommand, commands, readBatches } from '../command-journal/records.js';
import { availableMedia, catalogVariants, mediaRecords, validBlobIdentity, type MediaCatalog,
  type StoredAvatar, type StoredMediaReference } from '../media/records.js';
import type { BlobIdentity } from '../../storage/blobs/private-store.js';
import { BackupError, type CollectionPart, type Part } from './archive.js';

const maximumBsonBytes = 16 * 1024 * 1024;
const transient = new Set(['sessions', 'trustedDevices', 'recoveryGrants', 'oauthArtifacts']);
const referenceCollections = ['attachments', 'projectBackgrounds'] as const;

export function rawRows(db: Db, name: string) {
  return db.collection(name).find<Buffer>({}, { raw: true, batchSize: 64 }).sort({ _id: 1 });
}

export function bsonRecord(bytes: Buffer): Document {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > maximumBsonBytes
    || bytes.readInt32LE() !== bytes.length || bytes[bytes.length - 1] !== 0) throw new BackupError();
  try { return BSON.deserialize(bytes, { promoteValues: false, promoteLongs: false }); }
  catch { throw new BackupError('A backup BSON record is invalid.'); }
}

export function recordIdentity(name: string, value: Document) {
  if (name === 'installation') {
    if (value._id !== 'installation') throw new BackupError('The backup installation identity is invalid.');
  } else {
    if (!generationIdSchema.safeParse(value.generationId).success || !publicIdSchema.safeParse(value.id).success
        || value._id !== workspaceKey(value.generationId, value.id)) throw new BackupError('A backup row has an invalid workspace identity.');
  }
  return value._id as string;
}

async function readFully(file: FileHandle, buffer: Buffer, offset: number, start = 0) {
  let length = start;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, offset + length);
    if (!bytesRead) throw new BackupError('A backup BSON part is incomplete.');
    length += bytesRead;
  }
}

export async function* archiveRows(file: FileHandle, entry: CollectionPart) {
  const hash = createHash('sha256');
  let offset = 0;
  let rows = 0;
  let previous: string | undefined;
  while (offset < entry.byteLength) {
    if (entry.byteLength - offset < 5) throw new BackupError();
    const size = Buffer.allocUnsafe(4);
    await readFully(file, size, offset);
    const length = size.readInt32LE();
    if (length < 5 || length > maximumBsonBytes || length > entry.byteLength - offset) throw new BackupError();
    const bytes = Buffer.allocUnsafe(length);
    size.copy(bytes);
    await readFully(file, bytes, offset, 4);
    const record = bsonRecord(bytes);
    const id = recordIdentity(entry.name, record);
    if (previous !== undefined && previous >= id) throw new BackupError('Backup rows are not in unique identity order.');
    previous = id;
    offset += length;
    rows += 1;
    hash.update(bytes);
    yield { id, record, bytes };
  }
  if (rows !== entry.rows || hash.digest('hex') !== entry.sha256 || (await file.stat()).size !== entry.byteLength) {
    throw new BackupError('The backup BSON part does not match its inventory.');
  }
}

export function destinationRow(name: string, record: Document) {
  if (transient.has(name)) return null;
  if (name !== 'oauthConnections') return record;
  // Provider grant IDs are historical identities. Any linked access credentials require fresh consent.
  const permitted = new Set(['_id', 'id', 'generationId', 'userId', 'clientId', 'providerGrantId', 'revision',
    'createdAt', 'updatedAt', 'issuedAt', 'expiresAt', 'scope', 'scopes', 'revokedAt']);
  const retained = Object.fromEntries(Object.entries(record).filter(([field]) => permitted.has(field)));
  return { ...retained, revokedAt: record.revokedAt instanceof Date ? record.revokedAt : new Date(0) };
}

export async function digestRawRows(db: Db, name: string): Promise<CollectionPart> {
  const hash = createHash('sha256');
  let rows = 0;
  let byteLength = 0;
  for await (const bytes of rawRows(db, name)) {
    recordIdentity(name, bsonRecord(bytes));
    hash.update(bytes);
    rows += 1;
    byteLength += bytes.length;
  }
  return { name, rows, byteLength, sha256: hash.digest('hex') };
}

export async function mediaInventory(db: Db, activeGenerationId: string): Promise<BlobIdentity[]> {
  const all = new Map<string, number>();
  const add = (identity: BlobIdentity) => {
    if (!validBlobIdentity(identity)) throw new BackupError('A backup media identity is invalid.');
    const old = all.get(identity.digest);
    if (old !== undefined && old !== identity.byteLength) throw new BackupError('Backup media sizes disagree.');
    all.set(identity.digest, identity.byteLength);
  };
  async function addCatalog(generationId: string, digest: unknown, byteLength?: unknown) {
    if (!generationIdSchema.safeParse(generationId).success || typeof digest !== 'string') throw new BackupError();
    const metadata = await mediaRecords(db, generationId).catalog(digest);
    if (!metadata || !validBlobIdentity(metadata) || metadata.lifecycleState !== availableMedia
      || (byteLength !== undefined && metadata.byteLength !== byteLength)) throw new BackupError('A referenced media catalog entry is unavailable.');
    add(metadata);
    const variants = catalogVariants(metadata);
    if (variants) { add(variants.small); add(variants.large); }
  }
  for (const name of referenceCollections) {
    const rows = db.collection<StoredMediaReference>(name).find({ kind: 'file', availability: availableMedia, deletedAt: null },
      { projection: { generationId: 1, blobDigest: 1, byteLength: 1 } });
    for await (const row of rows) await addCatalog(row.generationId, row.blobDigest, row.byteLength ?? null);
  }
  const avatars = db.collection<StoredAvatar>('users').find({ 'avatarMedia.availability': availableMedia },
    { projection: { generationId: 1, avatarBlobDigest: 1, 'avatarMedia.byteLength': 1 } });
  for await (const row of avatars) await addCatalog(row.generationId, row.avatarBlobDigest, row.avatarMedia?.byteLength ?? null);

  // Active commands have recovered before capture. Prepared inactive commands may refer to published bytes.
  const pending = commands(db).find({ status: 'prepared' }, { promoteLongs: false, batchSize: 8 });
  for await (const command of pending) {
    checkCommand(command);
    if (command.generationId === activeGenerationId) throw new BackupError('The active Planner journal has pending recovery.');
    const catalogs = new Map<string, MediaCatalog>();
    const references = new Set<string>();
    for await (const batch of readBatches(db, command)) {
      for (const effect of batch) {
        if (effect.kind === 'delete') continue;
        if (effect.collection === 'blobs' && effect.kind === 'insert') {
          const candidate = effect.fields as unknown as MediaCatalog;
          if (!validBlobIdentity(candidate) || candidate.lifecycleState !== availableMedia) throw new BackupError();
          catalogs.set(candidate.digest, candidate);
          add(candidate);
          const variants = catalogVariants(candidate);
          if (variants) { add(variants.small); add(variants.large); }
        } else if (effect.collection === 'blobs' && effect.fields.variants) {
          const candidate = await db.collection<MediaCatalog>('blobs').findOne({ generationId: command.generationId, id: effect.id });
          if (!candidate) throw new BackupError();
          const combined = { ...candidate, variants: effect.fields.variants } as MediaCatalog;
          const variants = catalogVariants(combined);
          if (variants) { add(variants.small); add(variants.large); }
        }
        const digest = effect.collection === 'users' ? effect.fields.avatarBlobDigest
          : (effect.collection === 'attachments' || effect.collection === 'projectBackgrounds') ? effect.fields.blobDigest : null;
        if (digest !== null && digest !== undefined) {
          if (typeof digest !== 'string') throw new BackupError();
          references.add(digest);
        }
      }
    }
    for (const digest of references) if (!catalogs.has(digest)) await addCatalog(command.generationId, digest);
  }
  return [...all.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([digest, byteLength]) => ({ digest, byteLength }));
}

export const inventoryParts = (entries: BlobIdentity[]): Part[] => entries.map(({ digest, byteLength }) => ({ sha256: digest, byteLength }));
