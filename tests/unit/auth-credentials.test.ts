import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordSchema } from '../../packages/contracts/src/auth.ts';
import {
  createLoginRateLimit, csrfToken, hasValidCsrf, newToken, normalizeIdentifier, readSessionCookie, sessionCookie, tokenDigest,
} from '../../apps/backend/src/application/auth/credentials.ts';
import { createPasswordHasher, HashCapacityError } from '../../apps/backend/src/application/auth/password.ts';

test('password verification uses fresh salted scrypt and admits at most two derivations', async () => {
  const hasher = createPasswordHasher();
  const password = '  ä long p@sswörd 🔐  ';
  assert.equal(passwordSchema.safeParse('🔐'.repeat(128)).success, true);
  assert.equal(passwordSchema.safeParse('🔐'.repeat(129)).success, false);
  assert.equal(passwordSchema.safeParse('x'.repeat(11) + '\ud800').success, false);
  const first = hasher.encode(password);
  const second = hasher.encode(password);
  await assert.rejects(hasher.verify(password, null), HashCapacityError);
  const [a, b] = await Promise.all([first, second]);
  assert.match(a.salt, /^[0-9a-f]{32}$/u);
  assert.match(a.key, /^[0-9a-f]{64}$/u);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.key, b.key);
  assert.deepEqual(await Promise.all([hasher.verify(password, a), hasher.verify(password.trim(), a)]), [true, false]);
  assert.deepEqual(await Promise.all([hasher.verify(password, undefined), hasher.verify('short', a)]), [false, false]);
});

test('opaque cookies accept one canonical token and CSRF is bound to the exact session', () => {
  const token = newToken();
  const header = sessionCookie(token);
  const cookie = header.split(';', 1)[0];
  assert.match(header, /^__Host-planner-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax$/u);
  assert.equal(readSessionCookie(`another=example; ${cookie}`), token);
  assert.equal(readSessionCookie(`${cookie}; ${cookie}`), null);
  assert.equal(readSessionCookie(`__Host-planner-session=${token}=`), null);
  assert.equal(tokenDigest(token).length, 64);
  assert.equal(hasValidCsrf(token, csrfToken(token)), true);
  assert.equal(hasValidCsrf(newToken(), csrfToken(token)), false);
  assert.equal(hasValidCsrf(token, [csrfToken(token)]), false);
});

test('login limits normalized identifiers and source addresses independently and expires buckets', () => {
  let now = 0;
  const rate = createLoginRateLimit({ now: () => now, windowMs: 100, maximumBuckets: 64 });
  assert.equal(normalizeIdentifier('  Éxample  '), normalizeIdentifier('e\u0301xample'));
  for (let index = 0; index < 5; index++) assert.equal(rate('one', `192.0.2.${index + 1}`), true);
  assert.equal(rate('one', '192.0.2.9'), false);
  for (let index = 0; index < 30; index++) assert.equal(rate(`other-${index}`, '192.0.2.11'), true);
  assert.equal(rate('independent-user', '192.0.2.11'), false);
  assert.equal(rate('independent-user', '192.0.2.12'), true);
  now = 100;
  assert.equal(rate('one', '192.0.2.11'), true);
});
