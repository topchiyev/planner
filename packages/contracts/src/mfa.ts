import { z } from 'zod';
import { opaqueTokenSchema, passwordSchema, sessionSchema } from './auth.js';
import { publicIdSchema, utcInstantSchema } from './storage.js';

export const totpCodeSchema = z.string().regex(/^[0-9]{6}$/u);
const factorFields = [
  { totpCode: totpCodeSchema },
  { recoveryCode: opaqueTokenSchema },
] as const;

export const mfaChallengeSchema = z.strictObject({
  status: z.literal('challenge-required'),
  challengeId: opaqueTokenSchema,
});
export const mfaEnrollmentRequiredSchema = z.strictObject({
  status: z.literal('enrollment-required'),
  enrollmentId: opaqueTokenSchema,
});

export const loginWithMfaOutputSchema = z.union([sessionSchema, mfaChallengeSchema, mfaEnrollmentRequiredSchema]);

const challengeFields = { challengeId: opaqueTokenSchema, rememberDevice: z.boolean().optional() };
export const verifyMfaInputSchema = z.union([
  z.strictObject({ ...challengeFields, ...factorFields[0] }),
  z.strictObject({ ...challengeFields, ...factorFields[1] }),
]);
const reauthenticationFields = { password: passwordSchema };
export const reauthenticateMfaInputSchema = z.union([
  z.strictObject({ ...reauthenticationFields, ...factorFields[0] }),
  z.strictObject({ ...reauthenticationFields, ...factorFields[1] }),
]);
export const mfaEnrollmentInputSchema = z.strictObject({ enrollmentId: opaqueTokenSchema.optional() });
export const mfaEnrollmentOutputSchema = z.strictObject({
  enrollmentId: opaqueTokenSchema,
  secret: z.string().regex(/^[A-Z2-7]{32}$/u),
  uri: z.string().max(1024).regex(/^otpauth:\/\/totp\//u),
});
export const mfaEnrollmentVerifyInputSchema = z.strictObject({
  enrollmentId: opaqueTokenSchema,
  totpCode: totpCodeSchema,
});
export const recoveryCodesOutputSchema = z.strictObject({
  recoveryCodes: z.array(opaqueTokenSchema).length(10),
});
export const trustedDeviceSchema = z.strictObject({
  id: publicIdSchema,
  createdAt: utcInstantSchema,
  lastUsedAt: utcInstantSchema,
  expiresAt: utcInstantSchema,
  current: z.boolean(),
});
export const trustedDevicesOutputSchema = z.strictObject({ mfaEnabled: z.boolean(), devices: z.array(trustedDeviceSchema) });

export type VerifyMfaInput = z.infer<typeof verifyMfaInputSchema>;
export type ReauthenticateMfaInput = z.infer<typeof reauthenticateMfaInputSchema>;
export type MfaEnrollment = z.infer<typeof mfaEnrollmentOutputSchema>;
