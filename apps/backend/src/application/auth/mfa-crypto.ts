import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { newToken, tokenDigest } from './credentials.js';

export const factorStepMs = 30_000;
const algorithm = 'SHA1';
const cipher = 'aes-256-gcm';
const format = 'aes-256-gcm-v1';

export interface EncryptedFactorSecret {
  format: typeof format;
  iv: string;
  data: string;
  tag: string;
}

export interface FactorIdentity {
  installationId: string;
  generationId: string;
  userId: string;
  factorId: string;
}

export function isEncryptedFactorSecret(value: unknown): value is EncryptedFactorSecret {
  if (!value || typeof value !== 'object') return false;
  const secret = value as Partial<EncryptedFactorSecret>;
  return secret.format === format
    && typeof secret.iv === 'string' && /^[0-9a-f]{24}$/u.test(secret.iv)
    && typeof secret.data === 'string' && /^[0-9a-f]{40}$/u.test(secret.data)
    && typeof secret.tag === 'string' && /^[0-9a-f]{32}$/u.test(secret.tag);
}

function context({ installationId, generationId, userId, factorId }: FactorIdentity) {
  return Buffer.from(JSON.stringify(['Planner TOTP v1', installationId, generationId, userId, factorId]));
}

export function createTotpSecret(key: KeyObject, identity: FactorIdentity, label: string) {
  const secret = new Secret({ size: 20 });
  try {
    const totp = new TOTP({ issuer: 'Planner', label, algorithm, digits: 6, period: 30, secret });
    const iv = randomBytes(12);
    const encryption = createCipheriv(cipher, key, iv, { authTagLength: 16 });
    encryption.setAAD(context(identity));
    const data = Buffer.concat([encryption.update(secret.bytes), encryption.final()]);
    return {
      encrypted: { format, iv: iv.toString('hex'), data: data.toString('hex'), tag: encryption.getAuthTag().toString('hex') },
      secret: secret.base32,
      uri: totp.toString(),
    } as const;
  } finally { secret.bytes.fill(0); }
}

export function matchTotpCounter(
  key: KeyObject, identity: FactorIdentity, encrypted: EncryptedFactorSecret, token: string, time: Date, greatest = -1,
) {
  const counter = Math.floor(time.getTime() / factorStepMs);
  if (!/^[0-9]{6}$/u.test(token) || !Number.isSafeInteger(counter) || counter < 0) return null;
  if (!isEncryptedFactorSecret(encrypted)) throw new Error('Stored Planner TOTP factor is invalid.');
  const decryption = createDecipheriv(cipher, key, Buffer.from(encrypted.iv, 'hex'), { authTagLength: 16 });
  decryption.setAAD(context(identity));
  decryption.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
  const partial = decryption.update(Buffer.from(encrypted.data, 'hex'));
  let secret: Secret | undefined;
  try {
    decryption.final();
    secret = new Secret({ buffer: Uint8Array.from(partial).buffer });
    // Prefer the greatest represented counter if a six-digit value matches two steps.
    for (const candidate of [counter + 1, counter, counter - 1]) {
      if (candidate < 0 || candidate <= greatest) continue;
      if (TOTP.validate({ token, secret, algorithm, digits: 6, period: 30, window: 0, timestamp: candidate * factorStepMs }) !== null) {
        return candidate;
      }
    }
    return null;
  } finally {
    secret?.bytes.fill(0);
    partial.fill(0);
  }
}

export function issueRecoveryCodes() {
  const recoveryCodes = Array.from({ length: 10 }, newToken);
  return { recoveryCodes, digests: recoveryCodes.map(tokenDigest) };
}
