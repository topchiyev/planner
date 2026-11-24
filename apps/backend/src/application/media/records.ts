import type { Db } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { canonicalRow } from '../workspace/records.js';
import { digestPattern, MediaStorageError, type BlobIdentity } from '../../storage/blobs/private-store.js';
import { imageTypes, maximumDerivativeBytes, type MediaVariants } from './decoder.js';

export const availableMedia = 'available';
export const unavailableMedia = 'unavailable';
export const originalType = 'application/octet-stream';
export const derivativeType = 'image/png';

export interface MediaCatalog extends BlobIdentity {
  _id: string;
  generationId: string;
  id: string;
  revision?: number;
  lifecycleState: string;
  mimeType: string;
  variants?: MediaVariants | null;
}

export interface StoredMediaReference {
  _id: string;
  id: string;
  generationId: string;
  revision: number;
  name: string;
  kind: 'file' | 'link' | 'preset';
  cardId?: string;
  projectId?: string;
  availability?: string;
  blobDigest?: string | null;
  byteLength?: number | null;
  url?: string | null;
  deletedAt?: Date | null;
}

export interface StoredAvatar {
  _id: string;
  generationId: string;
  id: string;
  revision: number;
  disabledAt: Date | null;
  avatarBlobDigest?: string | null;
  avatarMedia?: { id: string; name: string; availability: string; byteLength: number } | null;
}

export function mediaByteLength(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function validBlobIdentity(identity: unknown): identity is BlobIdentity {
  if (!identity || typeof identity !== 'object') return false;
  const { digest, byteLength } = identity as Partial<BlobIdentity>;
  return typeof digest === 'string' && digestPattern.test(digest) && mediaByteLength(byteLength) !== null;
}

function validDerivative(identity: unknown): identity is BlobIdentity {
  return validBlobIdentity(identity) && identity.byteLength > 0 && identity.byteLength <= maximumDerivativeBytes;
}

export function catalogVariants(row: MediaCatalog) {
  const value = row.variants;
  if (row.mimeType === originalType && value == null) return null;
  if (!Object.values<string>(imageTypes).includes(row.mimeType) || value == null) throw new MediaStorageError();
  if (!validDerivative(value.small) || !validDerivative(value.large)) throw new MediaStorageError();
  return { small: { digest: value.small.digest, byteLength: value.small.byteLength },
    large: { digest: value.large.digest, byteLength: value.large.byteLength } };
}

export function canonicalMediaCatalog(generationId: string, digests: string[]) {
  return { digest: { $in: digests }, $expr: { $and: [canonicalRow(generationId), { $in: ['$digest', digests] }] } };
}

export function mediaRecords(database: Db, generationId: string) {
  const availableFile = (digest: string) => ({ generationId, blobDigest: digest, availability: availableMedia, deletedAt: null });
  const projection = { _id: 1 };
  const identity = (id: string) => ({ _id: workspaceKey(generationId, id), generationId, id });
  return {
    attachment: (id: string) => database.collection<StoredMediaReference>('attachments').findOne(identity(id)),
    background: (id: string) => database.collection<StoredMediaReference>('projectBackgrounds').findOne(identity(id)),
    avatar: (id: string) => database.collection<StoredAvatar>('users').findOne(identity(id), { projection: {
      id: 1, generationId: 1, revision: 1, disabledAt: 1, avatarBlobDigest: 1, avatarMedia: 1,
    } }),
    async hasAvailableReference(digest: string) {
      if (await database.collection('attachments').findOne(availableFile(digest), { projection })) return true;
      if (await database.collection('projectBackgrounds').findOne(availableFile(digest), { projection })) return true;
      return !!await database.collection('users').findOne({ generationId, avatarBlobDigest: digest,
        'avatarMedia.availability': availableMedia }, { projection });
    },
    catalog: (digest: string) => database.collection<MediaCatalog>('blobs')
      .findOne({ generationId, ...canonicalMediaCatalog(generationId, [digest]) }),
    occupiedCatalog: (digest: string) => database.collection('blobs').findOne({ generationId, digest }, { projection }),
  };
}
