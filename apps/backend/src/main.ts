import { fileURLToPath } from 'node:url';
import { buildApp } from './build-app.js';

const app = buildApp({
  isReady: async () => false,
  frontendRoot: fileURLToPath(new URL('../../frontend/dist/', import.meta.url)),
});

try {
  const configuredPort = process.env.PLANNER_HTTP_PORT ?? '27430';
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
