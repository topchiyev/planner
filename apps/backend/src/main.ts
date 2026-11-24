import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defaultAppPort, type NativeInstallationConfig } from '@planner/contracts';
import { buildApp } from './build-app.js';
import { checkMongoReadiness } from './native/mongo-readiness.js';
import { readInstallationConfig } from './native/setup-state.js';

let nativeConfig: NativeInstallationConfig | undefined;
const app = buildApp({
  isReady: async () => {
    await checkMongoReadiness(nativeConfig);
    // Schema, recovery and setup must also complete before the workspace can become ready.
    return false;
  },
  frontendRoot: fileURLToPath(new URL('../../frontend/dist/', import.meta.url)),
});

try {
  if (process.env.PLANNER_NATIVE_INSTALLATION === '1') {
    nativeConfig = readInstallationConfig(process.getgid?.() ?? -1);
    if (!nativeConfig) throw new Error('Planner native setup is incomplete.');
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await checkMongoReadiness(nativeConfig);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(250);
      }
    }
  }
  const configuredPort = nativeConfig ? String(nativeConfig.appPort)
    : process.env.PLANNER_HTTP_PORT ?? String(defaultAppPort);
  if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) > 65535) {
    throw new Error('Invalid Planner HTTP port');
  }

  const address = await app.listen({ host: '127.0.0.1', port: Number(configuredPort) });
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      console.error('Planner could not close its HTTP listener.');
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
  console.error('Planner could not start its HTTP listener.');
  process.exitCode = 1;
}
