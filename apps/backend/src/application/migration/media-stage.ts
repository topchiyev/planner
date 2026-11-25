import { mediaNameSchema } from '@planner/contracts';
import { nameBasedUuid } from '../../storage/identity.js';
import type { BlobIdentity, PrivateMediaStore } from '../../storage/blobs/private-store.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import type { MediaDecoder } from '../media/decoder.js';
import { MediaRejection } from '../media/errors.js';
import { availableMedia, unavailableMedia } from '../media/records.js';
import type { VerifiedSourceAsset } from './assets.js';
import { invalidBaseRow, targetTimes } from './base-fields.js';
import { MigrationError } from './manifest.js';
import { localMigrationMediaPublisher, type MigrationMediaPublisher } from './media-publication.js';
import type { VerifiedSourceSnapshot } from './preflight.js';
import { SourceJsonNumber, sourceKey, type SourceJson, type SourceRow } from './source-projections.js';
import type { ImportRecords } from './staged-records.js';

export const migrationMediaTables = ['attachment', 'background_image', 'uploaded_file', 'user_account'] as const;
type MediaTable = typeof migrationMediaTables[number];
export type MigrationMediaRow = { [K in MediaTable]: { table: K; row: SourceRow<K> } }[MediaTable];
export type MigrationMediaTarget = ({ store: PrivateMediaStore; decode: MediaDecoder } | { prepare: MigrationMediaPublisher })
  & { signal?: AbortSignal };
type MigrationMediaVerification = { signal?: AbortSignal; verifyBlob(identity: BlobIdentity): Promise<void> };

type UploadType = 'attachment' | 'backgroundImage' | 'userAvatar';
type SourceImage = { width: number; height: number; thumbnailsExtension: string };
type SourceFile = {
  uploadType: UploadType; uploadSourceId: string; sourceSize: string; originalKey: string; derivativeKeys: string[];
  mimeType?: string | null; image?: SourceImage | null; encoding?: string | null; creatorSourceId?: string | null;
};
export type ImportMediaProvenance =
  | { kind: 'link'; hostname: string; creatorSourceId: string | null }
  | { kind: 'upload'; uploadType: UploadType; mimeType: string | null; sourceSize: string; sourceReferenceCount: number | null }
  | (Omit<SourceFile, 'originalKey' | 'derivativeKeys'> & { kind: 'file'; original: VerifiedSourceAsset; derivatives: VerifiedSourceAsset[];
    state: 'available' | 'unavailable' });

function invalidMedia(): never {
  return invalidBaseRow('The source has invalid or inconsistent media metadata.');
}

function object(value: SourceJson | undefined) {
  if (!value || typeof value !== 'object' || value instanceof SourceJsonNumber || Array.isArray(value)) invalidMedia();
  return value;
}

function string(value: SourceJson | undefined) {
  if (typeof value !== 'string' || value.includes('\0')) invalidMedia();
  return value;
}

function optionalString(value: SourceJson | undefined) {
  return value == null ? null : string(value);
}

function nonnegative(value: SourceJson | undefined) {
  const exact = sourceKey('card', value instanceof SourceJsonNumber ? value.decimal : value);
  if (exact.startsWith('-')) invalidMedia();
  return exact;
}

function dimension(value: SourceJson | undefined) {
  const result = Number(nonnegative(value));
  if (!Number.isSafeInteger(result) || result < 1) invalidMedia();
  return result;
}

function extension(value: SourceJson | undefined) {
  const raw = string(value);
  if (!/^[a-z0-9]+$/u.test(raw)) invalidMedia();
  return raw;
}

function displayName(raw: string) {
  const result = mediaNameSchema.safeParse(raw);
  if (!result.success) invalidMedia();
  return result.data;
}

function attachmentFile(row: SourceRow<'attachment'>, data: ReturnType<typeof object>): SourceFile {
  const uploadSourceId = sourceKey('uploaded_file', data.uploadedFileId);
  const root = `private/attachments/${uploadSourceId}`;
  const image = data.image == null ? null : object(data.image);
  const sourceImage = image && { width: dimension(image.width), height: dimension(image.height),
    thumbnailsExtension: extension(image.thumbnailsExtension) };
  return {
    uploadType: 'attachment', uploadSourceId, sourceSize: nonnegative(data.size), mimeType: optionalString(data.mimeType),
    originalKey: `${root}/${string(data.filename)}`, derivativeKeys: sourceImage
      ? [360, 720].map((size) => `${root}/thumbnails/outside-${size}.${sourceImage.thumbnailsExtension}`) : [],
    image: sourceImage, encoding: optionalString(data.encoding), creatorSourceId: row.creator_user_id,
  };
}

function protectedFile(uploadType: 'backgroundImage' | 'userAvatar', id: string, suffix: string, size: string): SourceFile {
  const avatar = uploadType === 'userAvatar';
  const root = `protected/${avatar ? 'user-avatars' : 'background-images'}/${id}`;
  return { uploadType, uploadSourceId: id, sourceSize: size, originalKey: `${root}/original.${suffix}`,
    derivativeKeys: [`${root}/${avatar ? 'cover-180' : 'outside-360'}.${suffix}`] };
}

function uploadProvenance(row: SourceRow<'uploaded_file'>): ImportMediaProvenance {
  const { type, size, mime_type, references_total } = row;
  if (type !== 'attachment' && type !== 'backgroundImage' && type !== 'userAvatar'
      || (references_total !== null && references_total < 0)) invalidMedia();
  return { kind: 'upload', uploadType: type, mimeType: mime_type, sourceSize: nonnegative(size), sourceReferenceCount: references_total };
}

function verifiedAsset(snapshot: VerifiedSourceSnapshot, key: string, kind: VerifiedSourceAsset['kind']) {
  const asset = snapshot.asset(key);
  if (asset.kind !== kind) throw new MigrationError('asset-integrity', 'The source media key has an unexpected kind.');
  return asset;
}

type TargetFile = { availability: typeof availableMedia; blobDigest: string; byteLength: number }
  | { availability: typeof unavailableMedia; blobDigest: null };

export function createMigrationMediaStage(records: ImportRecords, snapshot: VerifiedSourceSnapshot, lease: WriterLease,
  target: MigrationMediaTarget | MigrationMediaVerification) {
  const signal = target.signal ?? new AbortController().signal;
  const fallback = snapshot.capture.capturedAt;

  async function importFile(table: Exclude<MediaTable, 'uploaded_file'>, sourceId: string, file: SourceFile,
    writeReference: (fields: TargetFile) => Promise<void>) {
    await records.require('uploaded_file', file.uploadSourceId);
    const upload = await snapshot.readUpload(file.uploadSourceId);
    if (!upload || upload.type !== file.uploadType) invalidMedia();
    const { originalKey, derivativeKeys, ...provenance } = file;
    const original = verifiedAsset(snapshot, originalKey, 'original');
    const derivatives = derivativeKeys.map((key) => verifiedAsset(snapshot, key, 'derivative'));
    const state = original.sha256 === null ? unavailableMedia : availableMedia;
    const persist = async (fields: TargetFile) => {
      await records.recordMediaProvenance(table, sourceId, { ...provenance, kind: 'file', original, derivatives, state });
      await writeReference(fields);
    };
    const { byteLength, sha256 } = original;
    if ('verifyBlob' in target) {
      if (sha256 === null || byteLength === null) return persist({ availability: unavailableMedia, blobDigest: null });
      await target.verifyBlob({ digest: sha256, byteLength });
      return persist({ availability: availableMedia, blobDigest: sha256, byteLength });
    }

    // The source variants remain evidence. Planner creates PNG variants at its own bounds from the original.
    for (const derivative of derivatives) {
      if (derivative.sha256 !== null) await snapshot.readAsset(derivative.key, signal, async (bytes) => {
        for await (const _chunk of bytes) { /* Verify the complete immutable response. */ }
      });
    }
    if (sha256 === null || byteLength === null) {
      return persist({ availability: unavailableMedia, blobDigest: null });
    }

    const prepare = 'prepare' in target ? target.prepare : localMigrationMediaPublisher(target.store, target.decode);
    let prepared: Awaited<ReturnType<MigrationMediaPublisher>> | undefined;
    try {
      prepared = await prepare({ digest: sha256, byteLength }, (consume, reading) =>
        snapshot.readAsset(original.key, reading, consume), signal);
      const { digest, byteLength: storedLength, mimeType, variants } = prepared.media;
      if (digest !== sha256 || storedLength !== byteLength)
        throw new MigrationError('asset-integrity', 'Staged media does not match the verified source bytes.');
      if (!variants && file.uploadType !== 'attachment')
        throw new MigrationError('asset-integrity', 'The verified profile or background asset is not a supported image.');
      signal.throwIfAborted();
      lease.assertHeld();
      await prepared.publish();
      signal.throwIfAborted();
      const blobId = nameBasedUuid(snapshot.capture.sourceInstanceId, `blob:${digest}`);
      await records.write('blobs', blobId, { digest, byteLength, mimeType, variants,
        lifecycleState: availableMedia, createdAt: new Date(fallback) });
      await persist({ availability: availableMedia, blobDigest: digest, byteLength });
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      if (error instanceof MediaRejection && error.kind === 'image')
        throw new MigrationError('asset-integrity', 'The verified image could not be decoded within the supported limits.');
      throw new MigrationError('target-write', 'The verified media could not be safely staged and published.');
    } finally { await prepared?.close(); }
  }

  return async (entry: MigrationMediaRow) => {
    signal.throwIfAborted();
    const id = await records.require(entry.table, entry.row.id);
    switch (entry.table) {
      case 'uploaded_file':
        return records.recordMediaProvenance(entry.table, entry.row.id, uploadProvenance(entry.row));
      case 'attachment': {
        const { row } = entry;
        const data = object(row.data.value);
        const cardId = await records.require('card', row.card_id);
        const creatorId = row.creator_user_id === null ? null : await records.resolve('user_account', row.creator_user_id);
        const common = { ...targetTimes(row, fallback), cardId, creatorId, name: displayName(row.name), deletedAt: null };
        if (row.type === 'link') {
          const url = string(data.url);
          const hostname = string(data.hostname);
          await records.recordMediaProvenance(entry.table, row.id, { kind: 'link', hostname, creatorSourceId: row.creator_user_id });
          return records.write('attachments', id, { ...common, kind: 'link', url, hostname });
        }
        if (row.type !== 'file') invalidMedia();
        return importFile(entry.table, row.id, attachmentFile(row, data),
          (fields) => records.write('attachments', id, { ...common, ...fields, kind: 'file', url: null }));
      }
      case 'background_image': {
        const { row } = entry;
        const projectId = await records.require('project', row.project_id);
        const file = protectedFile('backgroundImage', row.uploaded_file_id, extension(row.extension), nonnegative(row.size));
        return importFile(entry.table, row.id, file, (fields) => records.write('projectBackgrounds', id,
          { ...targetTimes(row, fallback), ...fields, projectId, name: 'Background', kind: 'file', deletedAt: null }));
      }
      case 'user_account': {
        const { row } = entry;
        if (row.avatar === null) {
          if ('verifyBlob' in target) await records.assertNoAvatar(row.id, id);
          return;
        }
        const data = object(row.avatar.value);
        const file = protectedFile('userAvatar', sourceKey('uploaded_file', data.uploadedFileId), extension(data.extension), nonnegative(data.size));
        const avatarId = nameBasedUuid(id, 'avatar');
        return importFile(entry.table, row.id, file, (fields) => records.stageAvatar(id, fields.blobDigest,
          { id: avatarId, name: 'Avatar', availability: fields.availability, byteLength: 'byteLength' in fields ? fields.byteLength : null }));
      }
    }
  };
}
