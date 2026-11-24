import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { opaqueTokenSchema } from '@planner/contracts';

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const normalizeIdentifier = (identifier: string) => identifier.trim().normalize('NFC').toLowerCase();

export function csrfToken(sessionToken: string) {
  return createHmac('sha256', sessionToken).update('Planner browser session CSRF v1').digest('base64url');
}

export function hasValidCsrf(sessionToken: string, supplied: unknown) {
  const parsed = opaqueTokenSchema.safeParse(supplied);
  return parsed.success && timingSafeEqual(Buffer.from(parsed.data), Buffer.from(csrfToken(sessionToken)));
}

export const sessionCookieName = '__Host-planner-session';
const cookieFlags = 'Path=/; Secure; HttpOnly; SameSite=Lax';
export const sessionCookie = (token: string) => `${sessionCookieName}=${token}; ${cookieFlags}`;
export const clearSessionCookie = `${sessionCookieName}=; Max-Age=0; ${cookieFlags}`;

export function readSessionCookie(header: string | undefined) {
  const prefix = `${sessionCookieName}=`;
  const values = header?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(prefix));
  if (values?.length !== 1) return null;
  const token = opaqueTokenSchema.safeParse(values[0].slice(prefix.length));
  return token.success ? token.data : null;
}

interface RateLimitOptions {
  now?: () => number;
  windowMs?: number;
  maximumBuckets?: number;
}

export function createLoginRateLimit({ now = () => performance.now(), windowMs = 15 * 60_000, maximumBuckets = 8_192 }: RateLimitOptions = {}) {
  const key = randomBytes(32);
  const buckets = new Map<string, { until: number; count: number }>();
  let nextSweep = 0;
  const bucketKey = (kind: string, value: string) => createHmac('sha256', key)
    .update(kind).update('\0').update(value).digest('hex');

  return (identifier: string, sourceAddress: string) => {
    const time = now();
    if (time >= nextSweep) {
      for (const [digest, bucket] of buckets) if (bucket.until <= time) buckets.delete(digest);
      nextSweep = time + windowMs / 4;
    }
    const checks = [[bucketKey('identifier', identifier), 5], [bucketKey('address', sourceAddress), 30]] as const;
    const entries = checks.map(([digest, limit]) => {
      const previous = buckets.get(digest);
      const bucket = previous && previous.until > time ? previous : { until: time + windowMs, count: 0 };
      return { digest, bucket, limit };
    });
    const newBuckets = entries.filter(({ digest }) => !buckets.has(digest)).length;
    if (buckets.size + newBuckets > maximumBuckets || entries.some(({ bucket, limit }) => bucket.count >= limit)) return false;
    for (const { digest, bucket } of entries) {
      bucket.count += 1;
      buckets.set(digest, bucket);
    }
    return true;
  };
}
