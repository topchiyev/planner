import { z } from 'zod';
import { accountEmailSchema, accountNameSchema, inactivitySchema, opaqueTokenSchema, passwordSchema, siteRoleSchema } from './auth.js';
import { publicIdSchema, revisionSchema, utcInstantSchema } from './storage.js';

const handlePattern = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u;
const emailAlias = z.email();
export const accountUsernameSchema = z.string().trim().min(1).max(64)
  .refine((value) => handlePattern.test(value) || emailAlias.safeParse(value).success).nullable();

const optionalText = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\p{Cc}\p{Cs}]+$/u).nullable();
const languageSchema = z.string().trim().max(35).regex(/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u).nullable();

export const preferencesSchema = z.strictObject({
  autoLogout: inactivitySchema,
  editorMode: z.enum(['wysiwyg', 'markup']),
  homeView: z.enum(['groupedProjects', 'gridProjects']),
  projectOrder: z.enum(['byDefault', 'alphabetically', 'byCreationTime']),
  followOwnCards: z.boolean(),
  followOnComment: z.boolean(),
  showFavorites: z.boolean(),
  highlightRecentlyChanged: z.boolean(),
});

const profileFields = z.strictObject({
  name: accountNameSchema,
  email: accountEmailSchema,
  username: accountUsernameSchema,
  phone: optionalText(80),
  organization: optionalText(120),
  language: languageSchema,
});

export const accountProfileSchema = profileFields.extend({ id: publicIdSchema, revision: revisionSchema });
export const profileUpdateSchema = profileFields.partial().extend({
  revision: revisionSchema,
  currentPassword: passwordSchema.optional(),
}).refine(({ revision: _revision, currentPassword: _password, ...fields }) => Object.keys(fields).length > 0);

export const accountPreferencesSchema = z.strictObject({ revision: revisionSchema, preferences: preferencesSchema });
export const preferencesUpdateSchema = z.strictObject({
  revision: revisionSchema,
  preferences: preferencesSchema.partial().refine((value) => Object.keys(value).length > 0),
});
export const passwordChangeSchema = z.strictObject({ currentPassword: passwordSchema, password: passwordSchema });
export const accountRecoveryInputSchema = z.strictObject({ grant: opaqueTokenSchema, password: passwordSchema });
export const accountRecoveryOutputSchema = z.union([
  z.strictObject({ status: z.enum(['confirmed', 'enrollment-required', 'staged-confirmed']) }),
  z.strictObject({ status: z.literal('staged-enrollment-required'), enrollmentId: opaqueTokenSchema }),
]);

const pageCursorSchema = z.string().regex(/^v1\.[A-Za-z0-9_-]+$/u).max(2048);
export const accountDirectoryQuerySchema = z.strictObject({
  cursor: pageCursorSchema.optional(),
  limit: z.string().regex(/^[1-9]\d{0,8}$/u).transform((value) => Math.min(Number(value), 100)).optional(),
  q: z.string().trim().max(120).optional(),
});
export const accountPersonSchema = z.strictObject({ id: publicIdSchema, name: accountNameSchema, role: siteRoleSchema });
export const adminAccountSchema = accountPersonSchema.extend({
  email: accountEmailSchema,
  username: accountUsernameSchema,
  revision: revisionSchema,
  disabled: z.boolean(),
  signIn: z.enum(['available', 'password-required', 'enrollment-required', 'disabled']),
});
export const accountDirectorySchema = z.strictObject({
  access: z.literal('directory'),
  accounts: z.array(accountPersonSchema).max(100),
  next: pageCursorSchema.nullable(),
}).or(z.strictObject({
  access: z.literal('administration'),
  accounts: z.array(adminAccountSchema).max(100),
  next: pageCursorSchema.nullable(),
}));
export const accountProvisionSchema = profileFields.pick({ name: true, email: true, username: true })
  .extend({ role: siteRoleSchema });
export const accountRevisionSchema = z.strictObject({ revision: revisionSchema });

const roleApprovalSchema = z.strictObject({ action: z.literal('role'), role: siteRoleSchema });
const disabledApprovalSchema = z.strictObject({ action: z.literal('availability'), disabled: z.boolean() });
export const accountAccessChangeSchema = z.discriminatedUnion('action', [
  roleApprovalSchema.extend({ revision: revisionSchema }),
  disabledApprovalSchema.extend({ revision: revisionSchema }),
]);
export const accountApprovalActionSchema = z.discriminatedUnion('action', [
  roleApprovalSchema, disabledApprovalSchema, z.strictObject({ action: z.literal('recovery') }),
]);
export const accountApprovalSchema = z.strictObject({
  id: publicIdSchema,
  actorId: publicIdSchema,
  targetId: publicIdSchema,
  revision: revisionSchema,
  change: accountApprovalActionSchema,
  expiresAt: utcInstantSchema,
});
export const accountApprovalResultSchema = z.strictObject({
  outcome: z.literal('applied'),
  approval: accountApprovalSchema,
  recovery: z.strictObject({ grant: opaqueTokenSchema, expiresAt: utcInstantSchema }).optional(),
});

export type AccountPreferences = z.infer<typeof preferencesSchema>;
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type AccountApproval = z.infer<typeof accountApprovalSchema>;
export type AccountApprovalAction = z.infer<typeof accountApprovalActionSchema>;
export type AccountDirectoryQuery = z.infer<typeof accountDirectoryQuerySchema>;
export type AccountProvision = z.infer<typeof accountProvisionSchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type PreferencesUpdate = z.infer<typeof preferencesUpdateSchema>;
export type PasswordChange = z.infer<typeof passwordChangeSchema>;
export type AccountRecoveryInput = z.infer<typeof accountRecoveryInputSchema>;

export const oauthConnectionPageSchema = z.strictObject({
  connections: z.array(z.strictObject({
    id: publicIdSchema,
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(['planner:read', 'planner:write'])).min(1).max(2),
    offline: z.boolean(),
    status: z.enum(['active', 'expired', 'revoked']),
    issuedAt: utcInstantSchema,
  })).max(50),
  next: publicIdSchema.nullable(),
});
