import { z } from 'zod';
import { publicIdSchema } from './storage.js';

export const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
export const passwordSchema = z.string().max(256).refine((value) => {
  const size = [...value].length;
  return size >= 12 && size <= 128 && !/\p{Surrogate}/u.test(value);
});
export const accountNameSchema = z.string().trim().min(1).max(120);
export const accountEmailSchema = z.string().trim().max(254).pipe(z.email());
export const siteRoleSchema = z.enum(['admin', 'projectOwner', 'boardUser']);
export const inactivitySchema = z.enum(['never', '2m', '5m', '10m', '30m', '12h']);

export const firstAdminInputSchema = z.strictObject({
  grant: opaqueTokenSchema,
  name: accountNameSchema,
  email: accountEmailSchema,
  password: passwordSchema,
});
export const loginInputSchema = z.strictObject({
  identifier: z.string().max(254),
  password: z.string().max(256),
});
export const sessionActorSchema = z.strictObject({
  id: publicIdSchema,
  name: accountNameSchema,
  role: siteRoleSchema,
});
// The proxy forwarding namespace is deliberately stripped from application requests.
export const passiveSessionHeader = 'planner-passive-read';

export const sessionSchema = z.strictObject({
  status: z.literal('authenticated'),
  account: sessionActorSchema,
  csrfToken: opaqueTokenSchema,
});
export const loginOutputSchema = z.union([
  sessionSchema,
  z.strictObject({ status: z.literal('enrollment-required') }),
]);
export const firstAdminOutputSchema = z.strictObject({ status: z.literal('confirmed') });

export type FirstAdminInput = z.infer<typeof firstAdminInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type SessionActor = z.infer<typeof sessionActorSchema>;
export type BrowserSession = z.infer<typeof sessionSchema>;
