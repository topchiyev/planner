import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultAppPort } from '@planner/contracts/native';
import { recoverAccountChanges } from './application/auth/account-credentials.js';
import { recoverFactorChanges } from './application/auth/mfa-account.js';
import { recoverFirstAdmin } from './application/auth/first-admin.js';
import { recoverMigrationAdmin } from './application/auth/migration-admin.js';
import type { CommandGate } from './application/command-gate/gate.js';
import { createMediaDecoder } from './application/media/decoder.js';
import { startMediaCleanup, sweepPrivateMedia, verifyActiveMedia } from './application/media/reconcile.js';
import { createPrivateMediaStore } from './storage/blobs/private-store.js';
import { buildApp, type AppDependencies } from './build-app.js';
import { adminRuntimeDirectory, startAdminSocket } from './native/admin-socket.js';
import { startNativeBoardEvents, type NativeBoardEvents } from './native/board-event-runtime.js';
import { createNativeBackup } from './native/backup-capture.js';
import { createNativeBrowserAuth } from './native/browser-auth.js';
import { startNativeCommandRecovery } from './native/command-recovery.js';
import { proxyTokenPattern } from './native/http-boundary.js';
import { createNativeMedia, withNativeMediaDatabase } from './native/media-routes.js';
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
let stopMediaCleanup: (() => void) | undefined;
let closeMedia: (() => Promise<void>) | undefined;
let boardEvents: NativeBoardEvents | undefined;

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
    const mediaStore = await createPrivateMediaStore('/var/lib/planner/staging', '/var/lib/planner/blobs');
    closeMedia = mediaStore.close;
    const mediaDecoder = createMediaDecoder(fileURLToPath(new URL('../../../lib/decode-media.py', import.meta.url)));
    const events = startNativeBoardEvents(config, gate, mfaKey.key);
    boardEvents = events;
    const auth = createNativeBrowserAuth(config, gate, mfaKey.key, events.streams);
    closeAdmin = await startAdminSocket(adminRuntimeDirectory, readAccess, auth.accountManagement, createNativeBackup(config, gate, mfaKey, mediaStore));
    dependencies = { frontendRoot, native: {
      origin: config.publicUrl, proxyToken, readAccess, auth,
      workspace: createNativeWorkspaceReader(config, gate, events.cursors),
      relationships: createNativeWorkspaceRelationships(config, gate, events.wake, events.streams.revalidateBoards),
      boardEvents: events.streams,
      media: createNativeMedia(config, gate, mediaStore, mediaDecoder),
    } };
    port = config.appPort;
    stopRecovery = startNativeCommandRecovery(config, gate, async (db, installationId) => {
      await recoverFirstAdmin(db, installationId);
      await recoverAccountChanges(db, installationId, events.streams.revalidateActor);
      await recoverMigrationAdmin(db, installationId);
      await recoverFactorChanges(db, installationId);
      await verifyActiveMedia(db, installationId, mediaStore);
      await sweepPrivateMedia(db, mediaStore);
    }, (db, installationId) => assertNativeMfaKey(db, installationId, mfaKey), events.streams.revalidateBoards);
    stopMediaCleanup = startMediaCleanup(gate, () => withNativeMediaDatabase(config, (db) =>
      gate.runCommand(() => sweepPrivateMedia(db, mediaStore))));
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
      stopMediaCleanup?.();
      boardEvents?.stop();
      await Promise.all([commandGate?.closeAndDrain(), app?.close(), closeAdmin?.(), closeProxy?.()]);
      await Promise.all([closeMedia?.(), boardEvents?.close()]);
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
  stopMediaCleanup?.();
  boardEvents?.stop();
  await Promise.allSettled([commandGate?.closeAndDrain(), app?.close(), closeAdmin?.(), closeProxy?.()]);
  await Promise.allSettled([closeMedia?.(), boardEvents?.close()]);
  console.error('Planner could not start its listeners.');
  process.exitCode = 1;
}
