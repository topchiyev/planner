import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from 'mongodb';
import {
  mediaBoardInvalidation, mediaMutationSchema, mediaOperations, safeMediaLink, type MediaMutation, type MediaVariant,
} from '@planner/contracts';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { newPublicId } from '../../storage/identity.js';
import { MediaSizeError, MediaStorageError, type BlobIdentity, type MediaPart, type PrivateMediaStore } from '../../storage/blobs/private-store.js';
import type { CommandGate } from '../command-gate/gate.js';
import { CommandJournal } from '../command-journal/journal.js';
import type { JournalFields, JournalOperation, JournalValue, PlannedEffect } from '../command-journal/operation.js';
import {
  requireCapability, resolveBrowserWorkspace, WorkspaceAccessError, type CardAccessContext,
  type ProjectAccessContext, type WorkspaceAuthorization,
} from '../workspace/authorization.js';
import { cardCovers } from '../workspace/card-media.js';
import { createWorkspaceRecords, directBoardRole } from '../workspace/records.js';
import { detectImage, imageTypes, type MediaDecoder, type MediaVariants } from './decoder.js';
import { MediaRejection, reserveSlots } from './errors.js';
import { receiveMultipart } from './multipart.js';
import { availableMedia, catalogVariants, mediaRecords, originalType, validBlobIdentity, type StoredAvatar, type StoredMediaReference } from './records.js';

type Upload = 'uploadAttachment' | 'uploadBackground' | 'uploadAvatar';
type Mutation = Upload | 'addLink' | 'renameAttachment' | 'removeAttachment' | 'removeBackground' | 'removeAvatar';
export type MediaIntent = Readonly<{
  operation: Mutation; id?: string; backgroundId?: string; expectedRevision: number; key: string;
}>;
type Admission = Readonly<{ intent: MediaIntent; generationId: string; actorId: string; parentId: string; boardId?: string }>;
type PreparedMedia = BlobIdentity & { name: string; mimeType: string; variants: MediaVariants | null };

export type MediaRead =
  | { kind: 'attachment'; id: string; variant?: MediaVariant }
  | { kind: 'background'; id: string; backgroundId: string; variant?: MediaVariant }
  | { kind: 'avatar'; id?: string; boardId?: string; variant: MediaVariant };

type Parent =
  | { type: 'card'; value: CardAccessContext; reference?: StoredMediaReference | null }
  | { type: 'project'; value: ProjectAccessContext; reference?: StoredMediaReference | null }
  | { type: 'avatar'; value: StoredAvatar };

const missing = () => new WorkspaceAccessError('missing');
const live = (row: StoredMediaReference | null | undefined): row is StoredMediaReference => !!row && row.deletedAt == null;

function revisionAfter(revision: number) {
  const parsed = revisionSchema.safeParse(revision + 1);
  if (!parsed.success) throw new MediaRejection('revision');
  return parsed.data;
}

function parentId(parent: Parent) {
  if (parent.type === 'card') return parent.value.card.id;
  if (parent.type === 'project') return parent.value.project.id;
  return parent.value.id;
}

function referenceDto(row: {
  id: string; revision: number; name: string; kind: 'file' | 'link'; byteLength?: number | null; url?: string | null; availability?: string | null;
}, id: string) {
  const url = row.kind === 'link' ? safeMediaLink(row.url) : null;
  return {
    id: row.id, parentId: id, revision: row.revision, name: row.name, kind: row.kind,
    byteLength: row.byteLength ?? null, url, available: row.kind === 'link' ? !!url : row.availability === availableMedia,
  };
}

export function createMediaService(
  database: Db, installationId: string, gate: CommandGate, store: PrivateMediaStore, decode: MediaDecoder,
  options: { now?: () => Date; checkpoint?: (point: string, index?: number) => void | Promise<void>; reserve?: () => () => void } = {},
) {
  const now = options.now ?? (() => new Date());
  const reserve = options.reserve ?? reserveSlots(4);
  const scopeFor = (token: string) => resolveBrowserWorkspace(database, installationId, token, now());

  async function writable(scope: WorkspaceAuthorization, intent: MediaIntent): Promise<Parent> {
    const records = mediaRecords(database, scope.generationId);
    switch (intent.operation) {
      case 'uploadAvatar':
      case 'removeAvatar': {
        const value = await records.avatar(scope.actor.id);
        if (!value) throw missing();
        return { type: 'avatar', value };
      }
      case 'uploadBackground':
      case 'removeBackground': {
        const value = await scope.requireProject(intent.id!);
        requireCapability(value.permissions.canEdit);
        const reference = intent.backgroundId ? await records.background(intent.backgroundId) : undefined;
        if (reference && reference.projectId !== value.project.id) throw missing();
        return { type: 'project', value, reference };
      }
      case 'renameAttachment':
      case 'removeAttachment': {
        const reference = await records.attachment(intent.id!);
        if (!reference || (reference.kind !== 'file' && reference.kind !== 'link') || !reference.cardId
            || !publicIdSchema.safeParse(reference.cardId).success || (intent.operation === 'renameAttachment' && !live(reference))) throw missing();
        const value = await scope.requireCard(reference.cardId);
        requireCapability(value.permissions.canEdit);
        return { type: 'card', value, reference };
      }
      default: {
        const value = await scope.requireCard(intent.id!);
        requireCapability(value.permissions.canEdit);
        return { type: 'card', value };
      }
    }
  }

  async function preflight(token: string, intent: MediaIntent) {
    return gate.readSnapshot(async (): Promise<Admission> => {
      const scope = await scopeFor(token);
      const parent = await writable(scope, intent);
      return Object.freeze({ intent, generationId: scope.generationId, actorId: scope.actor.id, parentId: parentId(parent),
        ...(parent.type === 'card' && { boardId: parent.value.board.board.id }) });
    });
  }

  async function currentAdmission(token: string, admission: Admission, generationId: string) {
    const scope = await scopeFor(token);
    if (scope.generationId !== generationId || generationId !== admission.generationId || scope.actor.id !== admission.actorId) {
      throw new WorkspaceAccessError('session');
    }
    const parent = await writable(scope, admission.intent);
    if (parentId(parent) !== admission.parentId || (parent.type === 'card' && parent.value.board.board.id !== admission.boardId)) {
      throw new MediaRejection('revision');
    }
    return parent;
  }

  async function ensureCatalog(generationId: string, media: PreparedMedia, timestamp: string): Promise<PlannedEffect[]> {
    const records = mediaRecords(database, generationId);
    const existing = await records.catalog(media.digest);
    if (existing) {
      if (!validBlobIdentity(existing) || existing.byteLength !== media.byteLength || existing.lifecycleState !== availableMedia
          || existing.mimeType !== media.mimeType) throw new MediaStorageError();
      const previous = catalogVariants(existing);
      if (!previous || !media.variants) return [];
      try {
        for (const variant of ['small', 'large'] as const) {
          const old = previous[variant];
          const incoming = media.variants[variant];
          if (old.digest !== incoming.digest || old.byteLength !== incoming.byteLength) await store.verifyBlob(old);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || await records.hasAvailableReference(media.digest)) throw new MediaStorageError();
        // A sweep may have removed an unreferenced legacy rendition before its original catalog row.
        return [{ kind: 'update', collection: 'blobs', id: existing.id, revision: existing.revision ?? null,
          fields: { variants: media.variants, updatedAt: timestamp } }];
      }
      return [];
    }
    return [{ kind: 'insert', collection: 'blobs', id: newPublicId(), fields: {
      digest: media.digest, byteLength: media.byteLength, mimeType: media.mimeType, variants: media.variants,
      lifecycleState: availableMedia, createdAt: timestamp,
    } }];
  }

  async function applyMutation(token: string, admission: Admission, payload: { name?: string; url?: string; media?: PreparedMedia }): Promise<MediaMutation> {
    const { intent } = admission;
    const { media } = payload;
    const operationId = mediaOperations[intent.operation].id;
    const operation: JournalOperation = {
      normalize: () => ({
        parentId: admission.parentId, ...(admission.boardId && { boardId: admission.boardId }),
        id: intent.id ?? null, backgroundId: intent.backgroundId ?? null, expectedRevision: intent.expectedRevision,
        name: media?.name ?? payload.name ?? null, url: payload.url ?? null, digest: media?.digest ?? null,
        byteLength: media?.byteLength ?? null,
      }),
      authorize: async (context) => { await currentAdmission(token, admission, context.generationId); },
      async plan({ generationId, timestamp }) {
        const parent = await currentAdmission(token, admission, generationId);
        const id = parentId(parent);
        const effects: PlannedEffect[] = [];
        let reference: MediaMutation['data']['reference'] = null;
        let coverAttachmentId: string | null | undefined;
        const lifecycle: JournalFields = media ? { blobDigest: media.digest, byteLength: media.byteLength, availability: availableMedia } : {};
        let parentRevision;

        if (parent.type === 'card') {
          const { card } = parent.value;
          const previous = parent.reference;
          const isChange = intent.operation === 'renameAttachment' || intent.operation === 'removeAttachment';
          if (isChange && !live(previous)) throw missing();
          if ((isChange ? previous!.revision : card.revision) !== intent.expectedRevision) throw new MediaRejection('revision');
          parentRevision = revisionAfter(card.revision);
          let nextCover: string | null | undefined;
          const currentCover = (await cardCovers(createWorkspaceRecords(database, generationId), generationId, [card])).get(id);
          coverAttachmentId = currentCover?.attachmentId ?? null;
          if (media) effects.push(...await ensureCatalog(generationId, media, timestamp));
          if (intent.operation === 'renameAttachment') {
            const revision = revisionAfter(previous!.revision);
            const name = payload.name!;
            const kind = previous!.kind === 'link' ? 'link' : 'file';
            effects.push({ kind: 'update', collection: 'attachments', id: previous!.id, revision: previous!.revision,
              fields: { name, updatedAt: timestamp } });
            reference = referenceDto({ ...previous!, name, revision, kind }, id);
          } else if (intent.operation === 'removeAttachment') {
            revisionAfter(previous!.revision);
            effects.push({ kind: 'update', collection: 'attachments', id: previous!.id, revision: previous!.revision,
              fields: { deletedAt: timestamp, blobDigest: null, url: null, updatedAt: timestamp } });
            if (card.coverAttachmentId === previous!.id) nextCover = null;
          } else {
            const mediaId = newPublicId();
            const name = media?.name ?? payload.name!;
            const kind = media ? 'file' : 'link';
            effects.push({ kind: 'insert', collection: 'attachments', id: mediaId, fields: {
              cardId: id, name, kind, url: payload.url ?? null, createdAt: timestamp, updatedAt: null, ...lifecycle,
            } });
            reference = referenceDto({ id: mediaId, revision: 1, name, kind, url: payload.url, byteLength: media?.byteLength,
              availability: media && availableMedia }, id);
            if (media?.variants && !currentCover) nextCover = mediaId;
          }
          if (nextCover !== undefined) coverAttachmentId = nextCover;
          effects.push({ kind: 'update', collection: 'cards', id, revision: card.revision,
            fields: { ...(nextCover !== undefined && { coverAttachmentId: nextCover }), updatedAt: timestamp } });
        } else if (parent.type === 'project') {
          const { project } = parent.value;
          if (project.revision !== intent.expectedRevision) throw new MediaRejection('revision');
          parentRevision = revisionAfter(project.revision);
          const projectFields: { updatedAt: string; backgroundId?: null; backgroundPreset?: null } = { updatedAt: timestamp };
          if (media) {
            effects.push(...await ensureCatalog(generationId, media, timestamp));
            const mediaId = newPublicId();
            effects.push({ kind: 'insert', collection: 'projectBackgrounds', id: mediaId,
              fields: { projectId: id, name: media.name, kind: 'file', createdAt: timestamp, updatedAt: null, ...lifecycle } });
            reference = referenceDto({ id: mediaId, revision: 1, name: media.name, kind: 'file', byteLength: media.byteLength,
              availability: availableMedia }, id);
          } else {
            if (!live(parent.reference)) throw missing();
            effects.push({ kind: 'delete', collection: 'projectBackgrounds', id: parent.reference.id, revision: parent.reference.revision });
            if (project.backgroundId === parent.reference.id) {
              projectFields.backgroundId = null;
              projectFields.backgroundPreset = null;
            }
          }
          effects.push({ kind: 'update', collection: 'projects', id, revision: project.revision, fields: projectFields });
        } else {
          const account = parent.value;
          if (account.revision !== intent.expectedRevision) throw new MediaRejection('revision');
          parentRevision = revisionAfter(account.revision);
          if (media) effects.push(...await ensureCatalog(generationId, media, timestamp));
          const avatar = media ? { id: newPublicId(), name: media.name, availability: availableMedia, byteLength: media.byteLength } : null;
          effects.push({ kind: 'update', collection: 'users', id, revision: account.revision,
            fields: { avatarBlobDigest: media?.digest ?? null, avatarMedia: avatar, updatedAt: timestamp } });
          if (avatar) reference = referenceDto({ ...avatar, revision: parentRevision, kind: 'file' }, id);
        }

        const result = { data: { reference, parent: { id, revision: parentRevision,
          ...(coverAttachmentId === undefined ? {} : { coverAttachmentId }) } } } satisfies JournalValue;
        const boardId = parent.type === 'card' ? parent.value.board.board.id : undefined;
        return { effects, result, audit: {
          resourceType: parent.type === 'avatar' ? 'account' : parent.type,
          resourceId: id, action: operationId, origin: 'web',
          ...(reference && { detail: { referenceId: reference.id } }),
        }, ...(boardId && { events: [mediaBoardInvalidation.parse({ boardId, kind: 'card.mediaChanged', payload: { id, revision: parentRevision } })] }) };
      },
    };
    const journal = new CommandJournal(gate, database, installationId, {
      operations: { [operationId]: operation }, checkpoint: options.checkpoint,
    });
    return mediaMutationSchema.parse(await journal.execute({
      actorId: admission.actorId, operationId, idempotencyKey: intent.key, input: null,
    }));
  }

  async function upload(token: string, admission: Admission, stream: Readable, headers: IncomingHttpHeaders, signal: AbortSignal) {
    const release = reserve();
    try {
      const stage = await store.stage();
      let unpin: (() => void) | undefined;
      try {
        const blob = await receiveMultipart(stream, headers, stage, signal);
        const format = detectImage(blob.prefix);
        if (!format && admission.intent.operation !== 'uploadAttachment') throw new MediaRejection('type');
        const variants = format ? await decode(stage, format, signal) : null;
        const parts: { part: MediaPart; identity: BlobIdentity }[] = [{ part: 'original', identity: blob.identity }];
        if (variants) parts.push({ part: 'small', identity: variants.small }, { part: 'large', identity: variants.large });
        signal.throwIfAborted();
        unpin = await stage.publish(parts);
        signal.throwIfAborted();
        return await applyMutation(token, admission, { media: { ...blob.identity, name: blob.name,
          mimeType: format ? imageTypes[format] : originalType, variants } });
      } catch (error) {
        if (error instanceof MediaSizeError) throw new MediaRejection('limit');
        throw error;
      } finally {
        try { await stage.dispose(); } finally { unpin?.(); }
      }
    } finally { release(); }
  }

  async function openForRead(token: string, target: MediaRead) {
    let opened: FileHandle | undefined;
    try {
      return await gate.readSnapshot(async () => {
        const scope = await scopeFor(token);
        const records = mediaRecords(database, scope.generationId);
        let reference: { id: string; revision: number; name: string; availability?: string; blobDigest?: string | null; byteLength?: number | null };
        if (target.kind === 'attachment') {
          const { attachment } = await scope.requireAttachment(target.id);
          const file = await records.attachment(attachment.id);
          if (!live(file) || file.kind !== 'file') throw missing();
          reference = file;
        } else if (target.kind === 'background') {
          const project = await scope.requireProject(target.id);
          const file = await records.background(target.backgroundId);
          if (!live(file) || file.kind !== 'file' || file.projectId !== project.project.id
              || (!project.manager && project.project.backgroundId !== file.id)) throw missing();
          reference = file;
        } else {
          const id = target.id ?? scope.actor.id;
          if (id !== scope.actor.id) {
            if (!target.boardId) throw missing();
            await scope.requireBoard(target.boardId);
            const member = await createWorkspaceRecords(database, scope.generationId).first('boardMembers',
              { boardId: target.boardId, userId: id, $expr: directBoardRole });
            if (!member) throw missing();
          }
          const user = await records.avatar(id);
          if (!user || user.disabledAt !== null || !user.avatarMedia) throw missing();
          reference = { ...user.avatarMedia, revision: user.revision, blobDigest: user.avatarBlobDigest };
        }
        if (reference.availability !== availableMedia || !validBlobIdentity({ digest: reference.blobDigest, byteLength: reference.byteLength })) {
          throw missing();
        }
        const blob = await records.catalog(reference.blobDigest!);
        if (!blob || blob.lifecycleState !== availableMedia) throw missing();
        if (!validBlobIdentity(blob) || blob.byteLength !== reference.byteLength) throw new MediaStorageError();
        const variant = target.variant;
        const identity = variant ? catalogVariants(blob)?.[variant] : blob;
        if (!identity) throw missing();
        const file = opened = await store.openBlob(identity);
        return { file, identity: { digest: identity.digest, byteLength: identity.byteLength }, name: reference.name,
          id: reference.id, revision: reference.revision, download: !variant };
      });
    } catch (error) {
      await opened?.close();
      throw error;
    }
  }

  return { preflight, upload, openForRead,
    mutate: (token: string, admission: Admission, payload: { name?: string; url?: string }) => applyMutation(token, admission, payload),
  };
}

export type MediaService = ReturnType<typeof createMediaService>;
