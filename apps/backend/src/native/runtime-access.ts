import type { NativeInstallationConfig } from '@planner/contracts/native';
import { readStagedMfaEnrollment } from '../application/auth/mfa-account.js';
import { firstAdminBinding, hasFirstAdminGrant } from '../application/auth/first-admin.js';
import { StorageSchemaError, verifyStorageSchema } from '../storage/schema.js';
import { checkDirectory } from './mongo-host.js';
import { databaseName } from './mongo-identity.js';
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
      if (config.mode === 'import') {
        const staged = await readStagedMfaEnrollment(database, config.installationId, new Date());
        return staged
          ? { kind: 'enrollment', step: 'mfa' }
          : { kind: 'unavailable', reason: 'migration' };
      }
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
