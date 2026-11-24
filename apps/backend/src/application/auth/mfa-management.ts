import type { KeyObject } from 'node:crypto';
import type { ReauthenticateMfaInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandGate } from '../command-gate/gate.js';
import { workspaceKey } from '../../storage/identity.js';
import { getLocalAccount } from './accounts.js';
import { tokenDigest } from './credentials.js';
import {
  applyFactorChange, getFactor, mfaAccounts, mfaActorScope, readStagedMfaEnrollment, verifyCurrentFactor,
} from './mfa-account.js';
import { createTotpSecret, issueRecoveryCodes, matchTotpCounter } from './mfa-crypto.js';
import {
  consumeMfaProof, findMfaProof, issueMfaProof, listTrustedDevices, recordFailedFactor, revokeTrustedDevice, setEnrollmentSecret,
} from './mfa-records.js';
import type { PasswordHasher } from './password.js';
import { activeAccountGeneration, loadCurrentBrowserSession } from './sessions.js';

export async function issueStagedMfaTicket(database: Db, installationId: string, time: Date) {
  const stage = await readStagedMfaEnrollment(database, installationId, time);
  if (!stage || !getLocalAccount(stage.account)) return null;
  const { recoveryId } = stage.scope;
  return issueMfaProof(database, mfaActorScope(installationId, stage.account), {
    kind: 'mfa-enrollment', source: 'staged', recoveryId,
  }, time);
}

interface EnrollmentAccess {
  enrollmentId?: string;
  sessionToken?: string;
}

export function createMfaManagement(
  database: Db, installationId: string, gate: CommandGate, key: KeyObject, hasher: PasswordHasher,
  now = () => new Date(),
) {
  const currentSession = (token: string, time: Date) => loadCurrentBrowserSession(database, installationId, token, time);
  async function enrollment({ enrollmentId, sessionToken }: EnrollmentAccess, time: Date) {
    if (!enrollmentId) return null;
    const active = await activeAccountGeneration(database, installationId);
    const stage = active ? null : await readStagedMfaEnrollment(database, installationId, time);
    const generationId = active ?? stage?.scope.generationId;
    if (!generationId) return null;
    const proof = await findMfaProof(database, installationId, generationId, 'mfa-enrollment', enrollmentId, time);
    if (!proof || proof.kind !== 'mfa-enrollment') return null;
    if (proof.source === 'staged') {
      if (!stage || stage.scope.recoveryId !== proof.recoveryId || stage.account.id !== proof.userId
          || stage.scope.credentialsVersion !== proof.credentialsVersion) return null;
      return { proof, user: stage.account, enrollmentId };
    }
    if (!active) return null;
    const user = await mfaAccounts(database).findOne({
      _id: workspaceKey(active, proof.userId), generationId: active, id: proof.userId,
    });
    const local = getLocalAccount(user);
    if (!user || !local || local.auth.credentialsVersion !== proof.credentialsVersion) return null;
    if (proof.source === 'password') {
      if (local.auth.mfa !== 'enrollment-required') return null;
    } else {
      if (local.auth.mfa !== 'none' || !sessionToken || tokenDigest(sessionToken) !== proof.sessionDigest) return null;
      const session = await currentSession(sessionToken, time);
      if (session?.account.actor.id !== user.id) return null;
    }
    return { proof, user, enrollmentId };
  }

  async function updateFactor(token: string, input: ReauthenticateMfaInput, action: 'recovery-codes-renewed' | 'disabled') {
    const candidate = await gate.readSnapshot(() => currentSession(token, now()));
    if (!candidate || !getFactor(candidate.stored)) return null;
    if (!await hasher.verify(input.password, candidate.account.auth.passwordVerifier)) return null;
    return gate.runCommand(async () => {
      const time = now();
      const session = await currentSession(token, time);
      if (!session || session.account.actor.id !== candidate.account.actor.id || session.generationId !== candidate.generationId
          || session.account.auth.credentialsVersion !== candidate.account.auth.credentialsVersion) return null;
      const factor = getFactor(session.stored);
      if (!factor) return null;
      const accepted = verifyCurrentFactor(key, installationId, session.stored, factor, input, time);
      if (!accepted) return null;
      const issued = action === 'recovery-codes-renewed' ? issueRecoveryCodes() : null;
      await applyFactorChange(database, installationId, session.stored, action,
        issued ? { ...factor, greatestCounter: accepted.counter ?? factor.greatestCounter, recoveryDigests: issued.digests } : null,
        time, accepted);
      return issued?.recoveryCodes ?? [];
    });
  }

  return {
    begin(access: EnrollmentAccess) {
      return gate.runCommand(async () => {
        const time = now();
        if (!access.enrollmentId && access.sessionToken) {
          const session = await currentSession(access.sessionToken, time);
          if (!session || session.account.auth.mfa !== 'none') return null;
          const enrollmentId = await issueMfaProof(database, mfaActorScope(installationId, session.stored), {
            kind: 'mfa-enrollment', source: 'session', sessionDigest: tokenDigest(access.sessionToken),
          }, time);
          access = { ...access, enrollmentId };
        }
        const state = await enrollment(access, time);
        if (!state || state.proof.encrypted !== undefined) return null;
        const { proof, user, enrollmentId } = state;
        const { secret, uri, encrypted } = createTotpSecret(key, {
          installationId, generationId: proof.generationId, userId: proof.userId, factorId: proof.id,
        }, user.email);
        await setEnrollmentSecret(database, proof, time, encrypted);
        return { enrollmentId, secret, uri };
      });
    },

    confirm(access: EnrollmentAccess, totpCode: string) {
      return gate.runCommand(async () => {
        const time = now();
        const state = await enrollment(access, time);
        if (!state?.proof.encrypted) return null;
        const { proof, user } = state;
        const encrypted = state.proof.encrypted;
        const greatestCounter = matchTotpCounter(key, {
          installationId, generationId: proof.generationId, userId: proof.userId, factorId: proof.id,
        }, encrypted, totpCode, time);
        if (greatestCounter === null) {
          await recordFailedFactor(database, proof, time);
          return null;
        }
        const codes = issueRecoveryCodes();
        await consumeMfaProof(database, proof, time);
        await applyFactorChange(database, installationId, user, 'enabled', {
          id: proof.id, encrypted, greatestCounter, recoveryDigests: codes.digests,
        }, time);
        return { recoveryCodes: codes.recoveryCodes };
      });
    },

    async renew(token: string, input: ReauthenticateMfaInput) {
      const recoveryCodes = await updateFactor(token, input, 'recovery-codes-renewed');
      return recoveryCodes ? { recoveryCodes } : null;
    },

    async disable(token: string, input: ReauthenticateMfaInput) {
      return (await updateFactor(token, input, 'disabled')) !== null;
    },

    list(token: string, trustedToken?: string) {
      return gate.readSnapshot(async () => {
        const time = now();
        const session = await currentSession(token, time);
        if (!session) return null;
        const mfaEnabled = !!getFactor(session.stored);
        const devices = mfaEnabled
          ? await listTrustedDevices(database, mfaActorScope(installationId, session.stored), time, trustedToken) : [];
        return { mfaEnabled, devices };
      });
    },

    revoke(token: string, id: string, trustedToken?: string) {
      return gate.runCommand(async () => {
        const time = now();
        const session = await currentSession(token, time);
        if (!session || !getFactor(session.stored)) return null;
        return revokeTrustedDevice(database, mfaActorScope(installationId, session.stored), time, id, trustedToken);
      });
    },
  };
}

export type MfaManagement = ReturnType<typeof createMfaManagement>;
