import type { NativeInstallationConfig } from '@planner/contracts/native';
import { StorageSchemaError, verifyStorageSchema } from '../storage/schema.js';
import { checkDirectory } from './mongo-host.js';
import { databaseName, uuidPattern } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export type RuntimeAccess =
  | { kind: 'ready' }
  | { kind: 'enrollment'; step: 'recovery' | 'mfa' }
  | { kind: 'unavailable'; reason: 'database' | 'staging' | 'setup' | 'migration' | 'schema-or-recovery' | 'probe' };

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
      if (installation.activeGenerationId !== null) {
        // Activation also needs command recovery to finish before serving ordinary workspace requests.
        return { kind: 'unavailable', reason: 'schema-or-recovery' };
      }
      if (config.mode === 'import') return { kind: 'unavailable', reason: 'migration' };

      const { pendingAction, enrollmentGenerationId, firstAdminGrantIssuedAt } = installation.setup;
      if (pendingAction !== 'first-admin-enrollment'
          || typeof enrollmentGenerationId !== 'string' || !uuidPattern.test(enrollmentGenerationId)
          || !(firstAdminGrantIssuedAt instanceof Date) || !Number.isFinite(firstAdminGrantIssuedAt.getTime())) {
        return { kind: 'unavailable', reason: 'setup' };
      }
      const grant = await database.collection('recoveryGrants').findOne({
        installationId: config.installationId,
        generationId: enrollmentGenerationId,
        kind: 'first-admin',
        issuedAt: firstAdminGrantIssuedAt,
        consumedAt: { $type: 'null' },
        expiresAt: { $gt: new Date() },
      }, { projection: { _id: 1 } });
      return grant ? { kind: 'enrollment', step: 'recovery' } : { kind: 'unavailable', reason: 'setup' };
    } finally {
      await client.close();
    }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof StorageSchemaError ? 'schema-or-recovery' : 'database' };
  }
}
