import { randomUUID } from 'node:crypto';
import { healthOperations, PLANNER_VERSION } from '@planner/contracts';
import Fastify from 'fastify';

export interface AppDependencies {
  isReady: () => Promise<boolean>;
}

export function buildApp({ isReady }: AppDependencies) {
  const app = Fastify({ requestIdHeader: false, genReqId: () => randomUUID() });

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
      if ((await isReady()) === true) {
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

  return app;
}
