import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultAppPort } from '@planner/contracts/native';
import { buildApp, type AppDependencies } from './build-app.js';
import { adminRuntimeDirectory, startAdminSocket } from './native/admin-socket.js';
import { proxyTokenPattern } from './native/http-boundary.js';
import { readProtectedFile } from './native/mongo-host.js';
import { boundedRuntimeProbe, inspectRuntimeAccess } from './native/runtime-access.js';
import { readInstallationConfig } from './native/setup-state.js';

let app: ReturnType<typeof buildApp> | undefined;
let closeAdmin: (() => Promise<void>) | undefined;

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
    const readAccess = boundedRuntimeProbe(() => inspectRuntimeAccess(config));
    // Apply this before binding the local operator socket, including direct service-account startup.
    process.umask(0o077);
    closeAdmin = await startAdminSocket(adminRuntimeDirectory, readAccess);
    dependencies = { frontendRoot, native: { origin: config.publicUrl, proxyToken, readAccess } };
    port = config.appPort;
  } else {
    const configuredPort = process.env.PLANNER_HTTP_PORT ?? String(defaultAppPort);
    if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) > 65535) throw new Error('Invalid Planner HTTP port.');
    dependencies = { frontendRoot, isReady: async () => false };
    port = Number(configuredPort);
  }

  app = buildApp(dependencies);
  const address = await app.listen({ host: '127.0.0.1', port });
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.all([app?.close(), closeAdmin?.()]);
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
  await Promise.allSettled([app?.close(), closeAdmin?.()]);
  console.error('Planner could not start its listeners.');
  process.exitCode = 1;
}
