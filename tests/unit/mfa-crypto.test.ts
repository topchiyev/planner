import assert from 'node:assert/strict';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Secret, TOTP } from 'otpauth';
import { mfaEnrollmentOutputSchema, recoveryCodesOutputSchema, verifyMfaInputSchema } from '../../packages/contracts/src/mfa.ts';
import { createTotpSecret, factorStepMs, issueRecoveryCodes, matchTotpCounter } from '../../apps/backend/src/application/auth/mfa-crypto.ts';

test('pinned TOTP utility produces the RFC 6238 SHA-1 vectors and six-digit suffixes', () => {
  const secret = Secret.fromLatin1('12345678901234567890');
  const reference = new TOTP({ secret, algorithm: 'SHA1', digits: 8, period: 30 });
  const planner = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 });
  for (const [seconds, expected] of [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ] as const) {
    const timestamp = seconds * 1000;
    assert.equal(reference.generate({ timestamp }), expected);
    assert.equal(planner.generate({ timestamp }), expected.slice(-6));
  }
});

test('factor encryption is installation and actor bound, with an exact one-step clock window', () => {
  const identity = { installationId: randomUUID(), generationId: randomUUID(), userId: randomUUID(), factorId: randomUUID() };
  const key = createSecretKey(randomBytes(32));
  const otherKey = createSecretKey(randomBytes(32));
  const { encrypted, secret, uri } = createTotpSecret(key, identity, 'Synthetic account');
  const totp = new TOTP({ secret: Secret.fromBase32(secret), issuer: 'Planner', label: 'Synthetic account', algorithm: 'SHA1', digits: 6, period: 30 });
  const time = new Date('2026-03-19T13:13:59.719Z');
  const counter = Math.floor(time.getTime() / factorStepMs);
  const generate = (offset: number) => totp.generate({ timestamp: (counter + offset) * factorStepMs });
  assert.equal(uri, totp.toString());
  assert.equal(Object.values(encrypted).some((value) => value.includes(secret)), false);
  assert.throws(() => matchTotpCounter(otherKey, identity, encrypted, generate(0), time));
  for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
    assert.throws(() => matchTotpCounter(key, { ...identity, [field]: randomUUID() }, encrypted, generate(0), time));
  }
  const changed = { ...encrypted, tag: (encrypted.tag.startsWith('0') ? '1' : '0') + encrypted.tag.slice(1) };
  assert.throws(() => matchTotpCounter(key, identity, changed, generate(0), time));
  for (const offset of [-1, 0, 1]) {
    const code = generate(offset);
    assert.equal(matchTotpCounter(key, identity, encrypted, code, time), counter + offset);
    assert.equal(matchTotpCounter(key, identity, encrypted, code, time, counter + offset), null);
  }
  assert.equal(matchTotpCounter(key, identity, encrypted, generate(2), time), null);
  assert.equal(matchTotpCounter(key, identity, encrypted, generate(-2), time), null);
  assert.equal(matchTotpCounter(key, identity, encrypted, ' 000000 ', time), null);
});

test('recovery codes use opaque 256-bit values and factor submissions choose one kind', () => {
  const { recoveryCodes, digests } = issueRecoveryCodes();
  assert.equal(new Set(recoveryCodes).size, 10);
  assert.equal(new Set(digests).size, 10);
  assert.ok(digests.every((digest) => /^[0-9a-f]{64}$/u.test(digest) && !recoveryCodes.includes(digest)));
  assert.equal(recoveryCodesOutputSchema.safeParse({ recoveryCodes }).success, true);
  assert.equal(mfaEnrollmentOutputSchema.safeParse({
    enrollmentId: recoveryCodes[0], secret: 'A'.repeat(32), uri: 'otpauth://totp/Fixture?secret=ignored',
  }).success, true);
  assert.equal(verifyMfaInputSchema.safeParse({ challengeId: recoveryCodes[0], totpCode: '000100' }).success, true);
  assert.equal(verifyMfaInputSchema.safeParse({ challengeId: recoveryCodes[0], recoveryCode: recoveryCodes[1] }).success, true);
  assert.equal(verifyMfaInputSchema.safeParse({
    challengeId: recoveryCodes[0], recoveryCode: recoveryCodes[1], totpCode: '000100',
  }).success, false);
});
