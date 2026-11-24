import { randomUUID } from 'node:crypto';
import { healthOperations, PLANNER_VERSION } from '@planner/contracts';
import Fastify from 'fastify';
import type { BoardEventStreams } from './application/board-events/streams.js';
import { registerFrontendShell } from './frontend-shell.js';
import { registerAccountRoutes } from './native/account-routes.js';
import { registerBoardEventRoutes } from './native/board-event-routes.js';
import { registerNativeBrowserAuth, type BrowserAuth } from './native/browser-auth.js';
import { registerMediaRoutes, type MediaAccess } from './native/media-routes.js';
import { registerNativeMfaRoutes } from './native/mfa-routes.js';
import { registerNativeHttpBoundary, type NativeHttpBoundary } from './native/http-boundary.js';
import { registerRelationshipRoutes, type WorkspaceRelationships } from './native/relationship-routes.js';
import { registerWorkspaceRoutes, type WorkspaceReader } from './native/workspace-routes.js';

type NativeAuthBoundary = NativeHttpBoundary & {
  auth: BrowserAuth;
  workspace?: WorkspaceReader;
  relationships?: WorkspaceRelationships;
  media?: MediaAccess;
  boardEvents?: BoardEventStreams;
};

export type AppDependencies = {
  frontendRoot?: string;
} & (
  { isReady: () => Promise<boolean>; native?: never; transportFixture?: never }
  | { native: NativeAuthBoundary; isReady?: never; transportFixture?: never }
  | { transportFixture: NativeHttpBoundary; isReady?: never; native?: never }
);

export function buildApp({ isReady, frontendRoot, native, transportFixture }: AppDependencies) {
  const app = Fastify({ requestIdHeader: false, genReqId: () => randomUUID() });
  const transport = native ?? transportFixture;
  app.decorateRequest('plannerConnection', null);
  if (transport) registerNativeHttpBoundary(app, transport);
  if (native) {
    registerNativeBrowserAuth(app, native.auth);
    if (native.auth.mfa) registerNativeMfaRoutes(app, native.auth.mfa);
    if (native.auth.accountManagement) registerAccountRoutes(app, native.auth.accountManagement);
    if (native.media) registerMediaRoutes(app, native.media);
    if (native.boardEvents) registerBoardEventRoutes(app, native.boardEvents);
    if (native.workspace) registerWorkspaceRoutes(app, native.workspace);
    if (native.relationships) registerRelationshipRoutes(app, native.relationships);
  }

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
      if (transport ? (await transport.readAccess()).kind === 'ready' : (await isReady?.()) === true) {
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

  if (frontendRoot) registerFrontendShell(app, frontendRoot, transport !== undefined, native !== undefined);
  return app;
}
