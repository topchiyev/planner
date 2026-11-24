import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';

export const recoveryLifetimeMs = 30 * 60_000;

export interface ProtectedGrant {
  _id: string;
  id: string;
  installationId: string;
  generationId: string;
  userId: string;
  actorId: string;
  targetEpoch: number;
  tokenDigest: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface RecoveryGrant extends ProtectedGrant {
  kind: 'account-recovery';
  actorEpoch: number;
  targetRevision: number;
}

export function isProtectedGrant(grant: ProtectedGrant, lifetime: number) {
  return publicIdSchema.safeParse(grant.id).success && publicIdSchema.safeParse(grant.actorId).success
    && publicIdSchema.safeParse(grant.userId).success && Number.isSafeInteger(grant.targetEpoch) && grant.targetEpoch >= 0
    && grant._id === workspaceKey(grant.generationId, grant.id)
    && typeof grant.tokenDigest === 'string' && /^[0-9a-f]{64}$/u.test(grant.tokenDigest)
    && isStoredDate(grant.issuedAt) && isStoredDate(grant.expiresAt)
    && grant.expiresAt.getTime() === grant.issuedAt.getTime() + lifetime;
}

export function isRecoveryGrant(grant: RecoveryGrant) {
  return grant.kind === 'account-recovery' && isProtectedGrant(grant, recoveryLifetimeMs)
    && Number.isSafeInteger(grant.actorEpoch) && grant.actorEpoch >= 0
    && revisionSchema.safeParse(grant.targetRevision).success;
}
