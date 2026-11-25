import { isDeepStrictEqual } from 'node:util';
import { migrationDigestSchema } from '@planner/contracts';
import { generationIdSchema, publicIdSchema, revisionSchema, signedInt64TextSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { importRunKey, type ImportRun } from '../migration/checkpoint.js';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../../storage/schema.js';
import { isProtectedGrant, recoveryLifetimeMs, type ProtectedGrant } from './account-grant.js';
import type { PasswordVerifier } from './password.js';

const bindingSchema = z.strictObject({
  runId: publicIdSchema, generationId: generationIdSchema, fingerprintSha256: migrationDigestSchema, reportSha256: migrationDigestSchema,
  manifestSha256: migrationDigestSchema, checkpointToken: z.string().regex(/^[\w-]{1,512}\.[\w-]{43}$/u),
  userId: publicIdSchema, sourceUserId: signedInt64TextSchema.nullable(), grantId: publicIdSchema,
  accountRevision: revisionSchema, credentialsVersion: z.number().int().positive(), requiresMfa: z.boolean(),
});
export type MigrationAdminBinding = z.infer<typeof bindingSchema>;

export interface MigrationAdminGrant extends ProtectedGrant {
  kind: 'migration-admin-recovery';
  binding: MigrationAdminBinding;
  claim?: { passwordVerifier: PasswordVerifier };
}

export const migrationAdminGrants = (db: Db) => db.collection<MigrationAdminGrant>('recoveryGrants');

export function coldMigrationAdminBinding(installation: InstallationDocument) {
  const setup = installation.setup;
  if (installation.activeGenerationId !== null || setup?.mode !== 'import' || setup.pendingAction !== 'migration-preflight') return null;
  const binding = bindingSchema.safeParse(setup.migrationAdminRecovery);
  return binding.success && setup.enrollmentGenerationId === binding.data.generationId ? binding.data : null;
}

export function sameVerifiedMigration(run: ImportRun, binding: MigrationAdminBinding) {
  return run.state === 'verified' && run.id === binding.runId && run.generationId === binding.generationId
    && run.fingerprint.sha256 === binding.fingerprintSha256 && run.verification?.reportSha256 === binding.reportSha256
    && run.manifestSha256 === binding.manifestSha256 && run.checkpoint?.pass === 'media' && run.checkpoint.token === binding.checkpointToken;
}

export async function readMigrationAdminBinding(db: Db, installationId: string) {
  const installation = await readInstallation(db, installationId);
  requireCurrentSchema(installation);
  const binding = coldMigrationAdminBinding(installation);
  if (!binding) return null;
  const run = await db.collection<ImportRun>('importRuns').findOne(importRunKey({ ...binding, installationId }));
  return run && sameVerifiedMigration(run, binding) ? binding : null;
}

export async function readMigrationAdminGrant(db: Db, installationId: string, binding: MigrationAdminBinding) {
  const grant = await migrationAdminGrants(db).findOne({
    _id: workspaceKey(binding.generationId, binding.grantId), id: binding.grantId, generationId: binding.generationId,
    installationId, userId: binding.userId, actorId: binding.userId, kind: 'migration-admin-recovery',
    targetEpoch: binding.credentialsVersion,
  });
  if (!grant || !isProtectedGrant(grant, recoveryLifetimeMs) || !isDeepStrictEqual(grant.binding, binding)) return null;
  if (grant.consumedAt !== null && (!isStoredDate(grant.consumedAt) || grant.consumedAt < grant.issuedAt || grant.consumedAt >= grant.expiresAt)) return null;
  if (grant.revokedAt !== null && (!isStoredDate(grant.revokedAt) || grant.revokedAt < grant.issuedAt)) return null;
  return grant;
}
