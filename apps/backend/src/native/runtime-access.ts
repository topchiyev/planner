import { generationIdSchema } from '@planner/contracts/storage';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { Db } from 'mongodb';
import { readStagedMfaEnrollment } from '../application/auth/mfa-account.js';
import { firstAdminBinding, hasFirstAdminGrant } from '../application/auth/first-admin.js';
import { canRecoverMigrationAdmin } from '../application/auth/migration-admin.js';
import { StorageSchemaError, verifyStorageSchema } from '../storage/schema.js';
import { checkDirectory } from './mongo-host.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export type RuntimeAccess =
  | { kind: 'ready' }
  | { kind: 'enrollment'; step: 'recovery' | 'account-recovery' | 'mfa' }
  | { kind: 'unavailable'; reason: 'database' | 'staging' | 'setup' | 'migration' | 'schema-or-recovery' | 'probe' };

export async function inspectColdMigrationAccess(database: Db, installationId: string, time: Date): Promise<RuntimeAccess> {
  if (await canRecoverMigrationAdmin(database, installationId, time)) return { kind: 'enrollment', step: 'account-recovery' };
  return await readStagedMfaEnrollment(database, installationId, time)
    ? { kind: 'enrollment', step: 'mfa' }
    : { kind: 'unavailable', reason: 'migration' };
}

export function boundedRuntimeProbe(check: () => Promise<RuntimeAccess>, timeoutMs = 3_000) {
  const unavailable = { kind: 'unavailable', reason: 'probe' } as const;
  let pending: Promise<RuntimeAccess> | undefined;
  let result: Promise<RuntimeAccess>;
  return async () => {
    if (!pending) {
      pending = Promise.resolve().then(check).catch(() => unavailable);
      let timer: NodeJS.Timeout;
      result = Promise.race([
        pending,
        new Promise<RuntimeAccess>((resolve) => { timer = setTimeout(() => resolve(unavailable), timeoutMs); }),
      ]);
      void pending.then(() => {
        clearTimeout(timer);
        pending = undefined;
      });
    }
    return result;
  };
}

export async function inspectRuntimeAccess(config: NativeInstallationConfig): Promise<RuntimeAccess> {
  try {
    checkDirectory('/var/lib/planner', 0, 0, 0o711);
    checkDirectory('/var/lib/planner/staging', process.getuid?.() ?? -1, process.getgid?.() ?? -1, 0o700);
  } catch {
    return { kind: 'unavailable', reason: 'staging' };
  }

  try {
    const client = await connectConfiguredNativeMongo(config);
    try {
      const database = client.db(databaseName);
      const installation = await verifyStorageSchema(database, config.installationId);
      if (installation.setup?.mode !== config.mode) return { kind: 'unavailable', reason: 'setup' };
      const restored = (installation as typeof installation & { restoration?: { phase?: unknown; generationId?: unknown; fingerprint?: unknown } }).restoration;
      if (restored !== undefined) {
        return restored?.phase === 'active' && generationIdSchema.safeParse(restored.generationId).success
          && restored.generationId === installation.activeGenerationId && typeof restored.fingerprint === 'string'
          && /^[a-f0-9]{64}$/u.test(restored.fingerprint) && installation.setup.pendingAction === 'complete'
          ? { kind: 'ready' } : { kind: 'unavailable', reason: 'setup' };
      }
      if (config.mode === 'import') return inspectColdMigrationAccess(database, config.installationId, new Date());
      const binding = firstAdminBinding(installation);
      if (binding?.published) return { kind: 'ready' };
      if (installation.activeGenerationId !== null) return { kind: 'unavailable', reason: 'schema-or-recovery' };

      return await hasFirstAdminGrant(database, installation, new Date())
        ? { kind: 'enrollment', step: 'recovery' }
        : { kind: 'unavailable', reason: 'setup' };
    } finally {
      await client.close();
    }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof StorageSchemaError ? 'schema-or-recovery' : 'database' };
  }
}
