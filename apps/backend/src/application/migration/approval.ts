import { migrationDigestSchema } from '@planner/contracts';
import { generationIdSchema, publicIdSchema, sourceAssetIdSchema } from '@planner/contracts/storage';
import { z } from 'zod';
import { MigrationError, sha256 } from './manifest.js';
import { compareSourceKeys } from './source-projections.js';

const missingOriginalSchema = z.strictObject({
  type: z.literal('uploaded_file'), sourceId: sourceAssetIdSchema, reason: z.literal('missing-original'),
});
const approvalSchema = z.strictObject({
  runId: publicIdSchema, snapshotSha256: migrationDigestSchema, missing: z.array(missingOriginalSchema),
});
export const activationExpectationSchema = z.strictObject({
  runId: publicIdSchema, generationId: generationIdSchema, manifestSha256: migrationDigestSchema,
  fingerprintSha256: migrationDigestSchema, reportSha256: migrationDigestSchema,
  missingOriginals: z.number().int().nonnegative(), approvalSha256: migrationDigestSchema.nullable(),
});
export type MissingOriginal = z.infer<typeof missingOriginalSchema>;
export type ActivationExpectation = z.infer<typeof activationExpectationSchema>;
type VerifiedExpectation = Omit<ActivationExpectation, 'approvalSha256' | 'missingOriginals'>;

function invalidApproval() {
  return new MigrationError('approval-invalid', 'The approval must exactly match the missing originals for this run and manifest.');
}

export function canonicalMissingOriginals(value: readonly MissingOriginal[]) {
  const missing = z.array(missingOriginalSchema).parse(value);
  missing.sort((first, second) => compareSourceKeys('uploaded_file', first.sourceId, second.sourceId));
  if (missing.some(({ sourceId }, index) => index > 0 && missing[index - 1].sourceId === sourceId)) throw invalidApproval();
  return missing;
}

export function activationExpectation(verified: VerifiedExpectation, missingOriginals: readonly MissingOriginal[],
  manifestSha256: string, approval?: unknown): ActivationExpectation {
  if (manifestSha256 !== verified.manifestSha256) throw invalidApproval();
  const missing = canonicalMissingOriginals(missingOriginals);
  let approvalSha256: string | null = null;
  if (approval === undefined) {
    if (missing.length > 0) {
      throw new MigrationError('approval-required', 'Verified missing originals require an exact local approval before activation.');
    }
  } else {
    const parsed = approvalSchema.safeParse(approval);
    if (!parsed.success || parsed.data.runId !== verified.runId || parsed.data.snapshotSha256 !== manifestSha256
      || missing.length === 0 || JSON.stringify(canonicalMissingOriginals(parsed.data.missing)) !== JSON.stringify(missing)) {
      throw invalidApproval();
    }
    approvalSha256 = sha256(Buffer.from(JSON.stringify({ runId: verified.runId, snapshotSha256: manifestSha256, missing })));
  }
  return activationExpectationSchema.parse({ ...verified, missingOriginals: missing.length, approvalSha256 });
}

export function assertActivationRetry(saved: ActivationExpectation, requested: ActivationExpectation) {
  const prior = activationExpectationSchema.parse(saved);
  const next = activationExpectationSchema.parse(requested);
  if (JSON.stringify(prior) !== JSON.stringify(next)) throw invalidApproval();
}
