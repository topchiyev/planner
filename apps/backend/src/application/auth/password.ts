import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { passwordSchema } from '@planner/contracts';

const parameters = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const keyLength = 32;

export interface PasswordVerifier {
  version: 'scrypt-v1';
  salt: string;
  key: string;
}

export function isPasswordVerifier(value: unknown): value is PasswordVerifier {
  if (!value || typeof value !== 'object') return false;
  const verifier = value as Partial<PasswordVerifier>;
  return verifier.version === 'scrypt-v1'
    && typeof verifier.salt === 'string' && /^[0-9a-f]{32}$/u.test(verifier.salt)
    && typeof verifier.key === 'string' && /^[0-9a-f]{64}$/u.test(verifier.key);
}

export class HashCapacityError extends Error {
  constructor() { super('Password verification is busy.'); }
}

export function createPasswordHasher() {
  let jobs = 0;
  // Match unknown identifiers against a process-local verifier with the same scrypt parameters.
  const dummy: PasswordVerifier = {
    version: 'scrypt-v1',
    salt: randomBytes(16).toString('hex'),
    key: randomBytes(keyLength).toString('hex'),
  };

  async function derive(password: string, salt: string) {
    if (jobs >= 2) throw new HashCapacityError();
    jobs += 1;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, Buffer.from(salt, 'hex'), keyLength, parameters,
          (error, key) => { if (error) reject(error); else resolve(key); });
      });
    } finally {
      jobs -= 1;
    }
  }

  return {
    async encode(password: string): Promise<PasswordVerifier> {
      const salt = randomBytes(16).toString('hex');
      const key = await derive(passwordSchema.parse(password), salt);
      return { version: 'scrypt-v1', salt, key: key.toString('hex') };
    },
    async verify(password: string, stored: unknown) {
      const validVerifier = isPasswordVerifier(stored);
      const validPassword = passwordSchema.safeParse(password);
      const verifier = validVerifier ? stored : dummy;
      const key = await derive(validPassword.success ? validPassword.data : 'invalid-password-length', verifier.salt);
      return timingSafeEqual(key, Buffer.from(verifier.key, 'hex')) && validVerifier && validPassword.success;
    },
  };
}

export type PasswordHasher = ReturnType<typeof createPasswordHasher>;
