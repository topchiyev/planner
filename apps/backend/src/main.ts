import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultAppPort } from '@planner/contracts/native';
import { recoverAccountChanges } from './application/auth/account-credentials.js';
import { recoverFactorChanges } from './application/auth/mfa-account.js';
import { recoverFirstAdmin } from './application/auth/first-admin.js';
import type { CommandGate } from './application/command-gate/gate.js';
import { buildApp, type AppDependencies } from './build-app.js';
import { adminRuntimeDirectory, startAdminSocket } from './native/admin-socket.js';
import { createNativeBrowserAuth } from './native/browser-auth.js';
import { startNativeCommandRecovery } from './native/command-recovery.js';
import { proxyTokenPattern } from './native/http-boundary.js';
import { assertNativeMfaKey, readNativeMfaKey } from './native/mfa-key.js';
import { readProtectedFile } from './native/mongo-host.js';
import { proxyRuntimeDirectory, startProxySocket } from './native/proxy-socket.js';
import { createNativeWorkspaceRelationships } from './native/relationship-routes.js';
import { boundedRuntimeProbe, inspectRuntimeAccess } from './native/runtime-access.js';
import { readInstallationConfig } from './native/setup-state.js';
import { createNativeCommandGate } from './native/writer.js';
import { createNativeWorkspaceReader } from './native/workspace-routes.js';

let app: ReturnType<typeof buildApp> | undefined;
let closeAdmin: (() => Promise<void>) | undefined;
let closeProxy: (() => Promise<void>) | undefined;
let commandGate: CommandGate | undefined;
let stopRecovery: (() => void) | undefined;

try {
  const frontendRoot = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  const native = process.env.PLANNER_NATIVE_INSTALLATION === '1';
  let port: number;
  let dependencies: AppDependencies;
  if (native) {
    const group = process.getgid?.() ?? -1;
    const config = readInstallationConfig(group);
    if (!config) throw new Error('Planner native setup is incomplete.');
    const run = lstatSync('/run');
    if (!run.isDirectory() || run.uid !== 0 || run.gid !== 0 || (run.mode & 0o022) !== 0) {
      throw new Error('Planner runtime directory is unsafe.');
    }
    const proxyToken = readProtectedFile('/etc/planner/proxy-token', group, 0o640)?.replace(/\n$/u, '');
    if (proxyToken !== undefined && !proxyTokenPattern.test(proxyToken)) throw new Error('Invalid Planner proxy token.');
    const gate = createNativeCommandGate();
    commandGate = gate;
    const readAccess = boundedRuntimeProbe(async () => {
      const unavailable = { kind: 'unavailable', reason: 'schema-or-recovery' } as const;
      if (!gate.ready) return unavailable;
      try {
        return await gate.readSnapshot(() => inspectRuntimeAccess(config));
      } catch {
        return unavailable;
      }
    });
    // Apply this before binding the local operator socket, including direct service-account startup.
    process.umask(0o077);
    const mfaKey = readNativeMfaKey(config.installationId, group);
    const auth = createNativeBrowserAuth(config, gate, mfaKey.key);
    closeAdmin = await startAdminSocket(adminRuntimeDirectory, readAccess, auth.accountManagement);
    dependencies = { frontendRoot, native: {
      origin: config.publicUrl, proxyToken, readAccess, auth, workspace: createNativeWorkspaceReader(config, gate),
      relationships: createNativeWorkspaceRelationships(config, gate),
    } };
    port = config.appPort;
    stopRecovery = startNativeCommandRecovery(config, gate, async (db, installationId) => {
      await recoverFirstAdmin(db, installationId);
      await recoverAccountChanges(db, installationId);
      await recoverFactorChanges(db, installationId);
    }, (db, installationId) => assertNativeMfaKey(db, installationId, mfaKey));
  } else {
    const configuredPort = process.env.PLANNER_HTTP_PORT ?? String(defaultAppPort);
    if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) > 65535) throw new Error('Invalid Planner HTTP port.');
    dependencies = { frontendRoot, isReady: async () => false };
    port = Number(configuredPort);
  }

  app = buildApp(dependencies);
  if (native) closeProxy = await startProxySocket(proxyRuntimeDirectory, app);
  const address = await app.listen({ host: '127.0.0.1', port });
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      stopRecovery?.();
      await Promise.all([commandGate?.closeAndDrain(), app?.close(), closeAdmin?.(), closeProxy?.()]);
    } catch {
      console.error('Planner could not close its listeners.');
      process.exitCode = 1;
    } finally {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    }
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(address);
} catch {
  stopRecovery?.();
  await Promise.allSettled([commandGate?.closeAndDrain(), app?.close(), closeAdmin?.(), closeProxy?.()]);
  console.error('Planner could not start its listeners.');
  process.exitCode = 1;
}
