import { Readable } from 'node:stream';
import { mediaAvatarQuerySchema, mediaBackgroundIdsSchema, mediaIdSchema, mediaLinkInputSchema, mediaMutationSchema, mediaOperations,
  mediaRenameSchema, mediaThumbnailIdsSchema, mediaVariantSchema, relationshipParentRevisionHeader } from '@planner/contracts';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { readSessionCookie } from '../application/auth/credentials.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import { CommandConflict, CommandInputError } from '../application/command-journal/operation.js';
import type { MediaDecoder } from '../application/media/decoder.js';
import { MediaRejection, mediaErrors, reserveSlots } from '../application/media/errors.js';
import { createMediaService, type MediaIntent, type MediaRead, type MediaService } from '../application/media/service.js';
import { WorkspaceAccessError } from '../application/workspace/authorization.js';
import type { PrivateMediaStore } from '../storage/blobs/private-store.js';
import { sendPrivateMedia } from './media-response.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export type MediaAccess = <T>(run: (service: MediaService) => Promise<T>) => Promise<T>;

export async function withNativeMediaDatabase<T>(config: NativeInstallationConfig, run: (database: Db) => Promise<T>) {
  const client = await connectConfiguredNativeMongo(config);
  try { return await run(client.db(databaseName)); }
  finally { await client.close(); }
}

export function createNativeMedia(config: NativeInstallationConfig, gate: CommandGate, store: PrivateMediaStore, decode: MediaDecoder): MediaAccess {
  const reserve = reserveSlots(4);
  return (run) => withNativeMediaDatabase(config, (db) => run(createMediaService(db, config.installationId, gate, store, decode, { reserve })));
}

function errorReply(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: { code, message, requestId: request.id } });
}

function respondError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (request.raw.aborted || reply.raw.destroyed) return;
  if (error instanceof WorkspaceAccessError) return errorReply(request, reply, error.statusCode, error.code, error.message);
  if (error instanceof MediaRejection) {
    const [status, code, message] = mediaErrors[error.kind];
    return errorReply(request, reply, status, code, message);
  }
  if (error instanceof CommandConflict) return errorReply(request, reply, 409, 'IDEMPOTENCY_CONFLICT', 'The key was already used for a different request.');
  if (error instanceof CommandInputError) return errorReply(request, reply, ...mediaErrors.input);
  return errorReply(request, reply, 503, 'UNAVAILABLE', 'Planner is unavailable.');
}

function browserToken(request: FastifyRequest) {
  const token = readSessionCookie(request.headers.cookie);
  if (!request.plannerConnection?.clientAddress || !request.plannerSession || !token) throw new WorkspaceAccessError('session');
  return token;
}

function mutationIntent(request: FastifyRequest, operation: MediaIntent['operation']): MediaIntent {
  const match = /^"([1-9]\d{0,15})"$/u.exec(request.headers['if-match'] ?? '');
  const revision = revisionSchema.safeParse(match ? Number(match[1]) : undefined);
  const key = publicIdSchema.safeParse(request.headers['idempotency-key']);
  const params = request.params as Record<string, unknown>;
  if (!revision.success || !key.success || Object.keys(request.query as object).length) throw new MediaRejection('input');
  const preconditions = { operation, expectedRevision: revision.data, key: key.data };
  if (operation === 'uploadAvatar' || operation === 'removeAvatar') return preconditions;
  const identity = (operation === 'removeBackground' ? mediaBackgroundIdsSchema : mediaIdSchema).safeParse(params);
  if (!identity.success) throw new MediaRejection('input');
  return { ...preconditions, ...identity.data };
}

async function runUpload(request: FastifyRequest, reply: FastifyReply, media: MediaService, token: string, intent: MediaIntent) {
  if (!(request.body instanceof Readable)) throw new MediaRejection('input');
  const abort = new AbortController();
  const disconnected = () => abort.abort(new MediaRejection('input'));
  const timer = setTimeout(() => abort.abort(new MediaRejection('timeout')), 45_000);
  timer.unref();
  request.raw.once('aborted', disconnected);
  reply.raw.once('close', disconnected);
  try {
    if (request.raw.aborted || reply.raw.destroyed) disconnected();
    const admission = await media.preflight(token, intent);
    abort.signal.throwIfAborted();
    return await media.upload(token, admission, request.body, request.headers, abort.signal);
  } finally {
    clearTimeout(timer);
    request.raw.off('aborted', disconnected);
    reply.raw.off('close', disconnected);
  }
}

const mutations = ['uploadAttachment', 'addLink', 'renameAttachment', 'removeAttachment', 'uploadBackground',
  'removeBackground', 'uploadAvatar', 'removeAvatar'] as const;
const reads = ['attachmentDownload', 'attachmentThumbnail', 'backgroundDownload', 'backgroundThumbnail', 'ownAvatar', 'userAvatar'] as const;

function readTarget(request: FastifyRequest, operation: typeof reads[number]): MediaRead {
  const params = request.params as Record<string, unknown>;
  const query = request.query as Record<string, unknown>;
  if (operation === 'ownAvatar' || operation === 'userAvatar') {
    const parsed = (operation === 'ownAvatar' ? mediaAvatarQuerySchema.omit({ boardId: true }) : mediaAvatarQuerySchema).safeParse(query);
    const identity = operation === 'userAvatar' ? mediaIdSchema.safeParse(params) : null;
    if (!parsed.success || (identity && !identity.success)) throw new MediaRejection('input');
    return { kind: 'avatar', ...parsed.data, ...identity?.data };
  }
  if (Object.keys(query).length) throw new MediaRejection('input');
  if (operation === 'attachmentThumbnail' || operation === 'attachmentDownload') {
    const parsed = (operation === 'attachmentThumbnail' ? mediaThumbnailIdsSchema : mediaIdSchema).safeParse(params);
    if (!parsed.success) throw new MediaRejection('input');
    return { kind: 'attachment', ...parsed.data };
  }
  const parsed = (operation === 'backgroundThumbnail' ? mediaBackgroundIdsSchema.extend({ variant: mediaVariantSchema }) : mediaBackgroundIdsSchema).safeParse(params);
  if (!parsed.success) throw new MediaRejection('input');
  return { kind: 'background', ...parsed.data };
}

export function registerMediaRoutes(app: FastifyInstance, access: MediaAccess) {
  app.register(async (routes) => {
    routes.addContentTypeParser('multipart/form-data', (_request, payload, done) => { done(null, payload); });
    for (const operation of mutations) {
      const { method, path } = mediaOperations[operation];
      const upload = operation === 'uploadAttachment' || operation === 'uploadBackground' || operation === 'uploadAvatar';
      routes.route({ method, url: path, bodyLimit: 8192, async handler(request, reply) {
        try {
          const token = browserToken(request);
          const intent = mutationIntent(request, operation);
          const result = await access(async (media) => {
            if (upload) return runUpload(request, reply, media, token, intent);
            const parsed = operation === 'addLink' ? mediaLinkInputSchema.safeParse(request.body)
              : operation === 'renameAttachment' ? mediaRenameSchema.safeParse(request.body)
                : { success: request.body == null, data: {} };
            if (!parsed.success) throw new MediaRejection('input');
            return media.mutate(token, await media.preflight(token, intent), parsed.data ?? {});
          });
          const response = mediaMutationSchema.parse(result);
          if (method === 'DELETE') return reply.header(relationshipParentRevisionHeader, response.data.parent.revision).code(204).send();
          return reply.code(operation === 'addLink' || operation === 'uploadAttachment' || operation === 'uploadBackground' ? 201 : 200).send(response);
        } catch (error) {
          if (upload && !request.raw.complete) reply.header('Connection', 'close');
          return respondError(request, reply, error);
        }
      } });
    }
    for (const operation of reads) {
      routes.route({ method: ['GET', 'HEAD'], url: mediaOperations[operation].path, exposeHeadRoute: false, async handler(request, reply) {
        try {
          const token = browserToken(request);
          const target = readTarget(request, operation);
          const opened = await access((media) => media.openForRead(token, target));
          return await sendPrivateMedia(request, reply, opened);
        } catch (error) { return respondError(request, reply, error); }
      } });
    }
  });
}
