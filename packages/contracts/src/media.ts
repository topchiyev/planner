import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';

export const maximumMediaBytes = 32 * 1024 * 1024;
export const maximumMediaEnvelope = maximumMediaBytes + 64 * 1024;
export const mediaVariantSchema = z.enum(['small', 'large']);
export const mediaNameSchema = z.string().trim().min(1).max(255).normalize()
  .refine((value) => value !== '.' && value !== '..' && !/[\/\\\p{Cc}\p{Cs}]/u.test(value));
export function safeMediaLink(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* Invalid external URLs are unavailable. */ }
  return null;
}

export const mediaLinkSchema = z.string().trim().min(1).max(2048).transform((value, context) => {
  const url = safeMediaLink(value);
  if (url) return url;
  context.issues.push({ code: 'custom', input: value, message: 'Expected an HTTP or HTTPS link.' });
  return z.NEVER;
});
export const mediaLinkInputSchema = z.strictObject({ name: mediaNameSchema, url: mediaLinkSchema });
export const mediaRenameSchema = z.strictObject({ name: mediaNameSchema });
export const mediaIdSchema = z.strictObject({ id: publicIdSchema });
export const mediaBackgroundIdsSchema = mediaIdSchema.extend({ backgroundId: publicIdSchema });
export const mediaThumbnailIdsSchema = mediaIdSchema.extend({ variant: mediaVariantSchema });
export const mediaAvatarQuerySchema = z.strictObject({ boardId: publicIdSchema.optional(), variant: mediaVariantSchema.default('small') });
export const mediaReferenceSchema = z.strictObject({
  id: publicIdSchema, parentId: publicIdSchema, revision: revisionSchema, name: mediaNameSchema,
  kind: z.enum(['file', 'link']), byteLength: z.number().int().nonnegative().nullable(),
  url: z.string().nullable(), available: z.boolean(),
});
export const mediaMutationSchema = z.strictObject({ data: z.strictObject({
  reference: mediaReferenceSchema.nullable(),
  parent: z.strictObject({ id: publicIdSchema, revision: revisionSchema, coverAttachmentId: publicIdSchema.nullable().optional() }),
}) });

export const mediaOperations = {
  uploadAttachment: { id: 'attachments.addFile', method: 'POST', path: '/api/v1/cards/:id/attachment-files' },
  addLink: { id: 'attachments.addLink', method: 'POST', path: '/api/v1/cards/:id/attachment-links' },
  renameAttachment: { id: 'attachments.update', method: 'PATCH', path: '/api/v1/attachments/:id' },
  removeAttachment: { id: 'attachments.delete', method: 'DELETE', path: '/api/v1/attachments/:id' },
  attachmentDownload: { id: 'attachments.download', path: '/api/v1/attachments/:id/download' },
  attachmentThumbnail: { id: 'attachments.thumbnail', path: '/api/v1/attachments/:id/thumbnail/:variant' },
  uploadBackground: { id: 'projects.uploadBackground', method: 'POST', path: '/api/v1/projects/:id/backgrounds' },
  removeBackground: { id: 'projects.removeBackground', method: 'DELETE', path: '/api/v1/projects/:id/backgrounds/:backgroundId' },
  backgroundDownload: { id: 'projects.downloadBackground', path: '/api/v1/projects/:id/backgrounds/:backgroundId/download' },
  backgroundThumbnail: { id: 'projects.backgroundThumbnail', path: '/api/v1/projects/:id/backgrounds/:backgroundId/thumbnail/:variant' },
  uploadAvatar: { id: 'accounts.uploadAvatar', method: 'PUT', path: '/api/v1/me/avatar' },
  removeAvatar: { id: 'accounts.removeAvatar', method: 'DELETE', path: '/api/v1/me/avatar' },
  ownAvatar: { id: 'accounts.ownAvatar', path: '/api/v1/me/avatar' },
  userAvatar: { id: 'accounts.userAvatar', path: '/api/v1/users/:id/avatar' },
} as const;

export type MediaVariant = z.infer<typeof mediaVariantSchema>;
export type MediaMutation = z.infer<typeof mediaMutationSchema>;
