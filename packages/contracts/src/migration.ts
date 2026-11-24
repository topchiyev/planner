import { z } from 'zod';
import { publicIdSchema } from './storage.js';

export const migrationDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestamp = z.iso.datetime({ precision: 3 });

export const migrationCaptureSchema = z.strictObject({
  formatVersion: z.literal(1),
  source: z.strictObject({
    release: z.enum(['2.3.0', '2.3.1']),
    edition: z.literal('community'),
    instanceId: publicIdSchema,
    postgresVersion: z.string().regex(/^[1-9][0-9]{0,2}\.[0-9]{1,6}(?:\.[0-9]{1,6})?$/u),
    dumpSha256: migrationDigestSchema,
  }),
  capturedAt: timestamp,
  asset: z.strictObject({
    kind: z.enum(['directory', 'object']),
    snapshotId: publicIdSchema,
    manifestSha256: migrationDigestSchema,
  }),
});

export const migrationAssetSchema = z.strictObject({
  key: z.string().min(1).max(2048),
  size: z.number().int().nonnegative(),
  sha256: migrationDigestSchema,
  versionId: z.string().regex(/^[\w.+=/-]{1,512}$/u).refine((value) => value !== 'null').optional(),
});

export const migrationAssetsSchema = z.strictObject({
  formatVersion: z.literal(1),
  files: z.array(migrationAssetSchema).max(100_000),
});

export type MigrationCapture = z.infer<typeof migrationCaptureSchema>;
export type MigrationAsset = z.infer<typeof migrationAssetSchema>;
