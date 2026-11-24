import { randomUUID } from 'node:crypto';
import { healthOperations, PLANNER_VERSION } from '@planner/contracts';
import Fastify from 'fastify';
import { registerFrontendShell } from './frontend-shell.js';
import { registerNativeHttpBoundary, type NativeHttpBoundary } from './native/http-boundary.js';

export type AppDependencies = {
  frontendRoot?: string;
} & ({ isReady: () => Promise<boolean>; native?: never } | { native: NativeHttpBoundary; isReady?: never });

export function buildApp({ isReady, frontendRoot, native }: AppDependencies) {
  const app = Fastify({ requestIdHeader: false, genReqId: () => randomUUID() });
  app.decorateRequest('plannerConnection', null);
  if (native) registerNativeHttpBoundary(app, native);

  app.get('/health/live', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return healthOperations.live.output.parse({
      status: 'live',
      version: PLANNER_VERSION,
      requestId: request.id,
    });
  });

  app.get('/health/ready', async (request, reply) => {
    let status: 'ready' | 'unavailable' = 'unavailable';
    try {
      if (native ? (await native.readAccess()).kind === 'ready' : (await isReady()) === true) {
        status = 'ready';
      }
    } catch {
      // Probe errors are operator information. Readiness exposes only the resulting state.
    }

    reply.code(status === 'ready' ? 200 : 503).header('Cache-Control', 'no-store');
    return healthOperations.readiness.output.parse({
      status,
      version: PLANNER_VERSION,
      requestId: request.id,
    });
  });

  if (frontendRoot) registerFrontendShell(app, frontendRoot, native !== undefined);
  return app;
}
