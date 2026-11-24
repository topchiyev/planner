import type { Db } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { digestPattern, MediaStorageError, type BlobIdentity } from '../../storage/blobs/private-store.js';
import type { MediaVariants } from './decoder.js';

export const availableMedia = 'available';
export const originalType = 'application/octet-stream';
export const derivativeType = 'image/png';

export interface MediaCatalog extends BlobIdentity {
  _id: string;
  generationId: string;
  id: string;
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

export function validBlobIdentity(identity: unknown): identity is BlobIdentity {
  if (!identity || typeof identity !== 'object') return false;
  const { digest, byteLength } = identity as Partial<BlobIdentity>;
  return typeof digest === 'string' && digestPattern.test(digest) && typeof byteLength === 'number'
    && Number.isSafeInteger(byteLength) && byteLength >= 0;
}

export function catalogVariants(row: MediaCatalog) {
  const value = row.variants;
  if (value == null) return null;
  if (!validBlobIdentity(value.small) || !validBlobIdentity(value.large)) throw new MediaStorageError();
  return { small: { digest: value.small.digest, byteLength: value.small.byteLength },
    large: { digest: value.large.digest, byteLength: value.large.byteLength } };
}

export function mediaRecords(database: Db, generationId: string) {
  const identity = (id: string) => ({ _id: workspaceKey(generationId, id), generationId, id });
  return {
    attachment: (id: string) => database.collection<StoredMediaReference>('attachments').findOne(identity(id)),
    background: (id: string) => database.collection<StoredMediaReference>('projectBackgrounds').findOne(identity(id)),
    avatar: (id: string) => database.collection<StoredAvatar>('users').findOne(identity(id), { projection: {
      id: 1, generationId: 1, revision: 1, disabledAt: 1, avatarBlobDigest: 1, avatarMedia: 1,
    } }),
    catalog: (digest: string) => database.collection<MediaCatalog>('blobs').findOne({ generationId, digest }),
  };
}
