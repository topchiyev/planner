import { z } from 'zod';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-';
const uuidEnd = '[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export const installationIdSchema = z.string().regex(new RegExp(`^${uuid}4${uuidEnd}$`, 'u'));
export const generationIdSchema = installationIdSchema;
export const publicIdSchema = z.string().regex(new RegExp(`^${uuid}[45]${uuidEnd}$`, 'u'));
export const sourceUuidSchema = z.string().regex(new RegExp(`^${uuid}[1-8]${uuidEnd}$`, 'u'));
export const sourceEntitySchema = z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/u);

export const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const nonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const utcInstantSchema = z.iso.datetime({ precision: 3 });
export const nullableUtcInstantSchema = utcInstantSchema.nullable();

export const minimumSignedInt64 = -(2n ** 63n);
export const maximumSignedInt64 = 2n ** 63n - 1n;
export const rankSpacing = 1024n;

export const signedInt64TextSchema = z.string().refine((value) => {
  if (!/^(?:0|-?[1-9][0-9]{0,18})$/u.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= minimumSignedInt64 && parsed <= maximumSignedInt64;
}, { message: 'Expected a canonical signed 64-bit decimal integer.' });

export const sourceAssetIdSchema = z.union([signedInt64TextSchema, sourceUuidSchema]);
