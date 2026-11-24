import type { KeyObject } from 'node:crypto';
import type { VerifyMfaInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { getLocalAccount, type AccountRecord } from './accounts.js';
import { consumeFactor, getFactor, hasPasswordOnlyAuth, hasPendingFactorEnrollment, mfaAccounts, mfaActorScope, verifyCurrentFactor } from './mfa-account.js';
import { consumeMfaProof, createTrustedDevice, findMfaProof, issueMfaProof, recordFailedFactor, useTrustedDevice } from './mfa-records.js';

export async function beginPasswordMfa(
  db: Db, installationId: string, account: AccountRecord, time: Date, trustedToken?: string,
) {
  const local = getLocalAccount(account);
  if (!local) return { status: 'invalid' } as const;
  if (local.auth.mfa === 'none') return { status: hasPasswordOnlyAuth(account) ? 'passed' : 'invalid' } as const;
  const scope = mfaActorScope(installationId, account);
  if (local.auth.mfa === 'enrollment-required') {
    if (!hasPendingFactorEnrollment(account)) return { status: 'invalid' } as const;
    const enrollmentId = await issueMfaProof(db, scope, { kind: 'mfa-enrollment', source: 'password' }, time);
    return { status: 'enrollment-required', enrollmentId } as const;
  }
  const factor = getFactor(account);
  if (!factor) return { status: 'invalid' } as const;
  if (trustedToken && await useTrustedDevice(db, scope, time, trustedToken)) {
    return { status: 'passed', factorId: factor.id } as const;
  }
  const challengeId = await issueMfaProof(db, scope, { kind: 'mfa-challenge', factorId: factor.id }, time);
  return { status: 'challenge-required', challengeId } as const;
}

// Password verification has already issued this proof. The caller holds the writer through session issuance.
export async function verifyPasswordMfa(
  database: Db, installationId: string, generationId: string, key: KeyObject, input: VerifyMfaInput, time: Date,
  allowActorAttempt = (_userId: string) => true,
) {
  const challenge = await findMfaProof(database, installationId, generationId, 'mfa-challenge', input.challengeId, time);
  if (!challenge || challenge.kind !== 'mfa-challenge') return null;
  const user = await mfaAccounts(database).findOne({
    _id: workspaceKey(generationId, challenge.userId), generationId, id: challenge.userId,
  });
  const account = getLocalAccount(user);
  if (!user || !account || account.auth.credentialsVersion !== challenge.credentialsVersion) return null;
  const factor = getFactor(user);
  if (!factor || factor.id !== challenge.factorId || !allowActorAttempt(user.id)) return null;
  const accepted = verifyCurrentFactor(key, installationId, user, factor, input, time);
  if (!accepted) {
    await recordFailedFactor(database, challenge, time);
    return null;
  }

  await consumeMfaProof(database, challenge, time);
  await consumeFactor(database, user, factor, accepted);
  const trustedToken = input.rememberDevice ? await createTrustedDevice(database, mfaActorScope(installationId, user), time) : undefined;
  return { account, factorId: factor.id, trustedToken };
}
