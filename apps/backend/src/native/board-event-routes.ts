import { boardEventsPath } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readSessionCookie } from '../application/auth/credentials.js';
import { BoardStreamLimit, type BoardEventStreams } from '../application/board-events/streams.js';
import { WorkspaceAccessError } from '../application/workspace/authorization.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    plannerPassiveSession?: true;
  }
}

function fail(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: { code, message, requestId: request.id } });
}

export function registerBoardEventRoutes(app: FastifyInstance, streams: BoardEventStreams) {
  app.get<{ Params: { id: string }; Querystring: { after?: unknown } }>(
    boardEventsPath, { config: { plannerPassiveSession: true }, exposeHeadRoute: false },
    async (request, reply) => {
      const token = readSessionCookie(request.headers.cookie);
      if (!request.plannerConnection?.clientAddress || !token) {
        return fail(request, reply, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
      }
      if (request.headers.origin !== undefined && request.headers.origin !== request.plannerConnection.origin) {
        return fail(request, reply, 403, 'FORBIDDEN', 'This request is not allowed.');
      }
      const id = publicIdSchema.safeParse(request.params.id);
      if (!id.success || Object.keys(request.query).some((key) => key !== 'after')) {
        return fail(request, reply, 422, 'INVALID_REQUEST', 'Check the board event request.');
      }
      const after = request.headers['last-event-id'] ?? request.query.after;
      const response = reply.raw;
      const disconnected = new AbortController();
      response.once('close', () => disconnected.abort());
      let begun = false;
      try {
        await streams.subscribe(token, id.data, after, {
          begin() {
            reply.hijack();
            begun = true;
            response.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Accel-Buffering': 'no',
            });
            response.flushHeaders();
          },
          frame(frame, cursor) {
            const id = cursor === undefined ? '' : 'id: ' + cursor + '\n';
            return response.write(id + 'event: ' + frame.event + '\ndata: ' + JSON.stringify(frame.data) + '\n\n');
          },
          heartbeat: () => response.write(': heartbeat\n\n'),
          close: (abort) => { if (abort) response.destroy(); else response.end(); },
        }, disconnected.signal);
      } catch (error) {
        if (begun || disconnected.signal.aborted) {
          response.destroy();
        } else if (error instanceof WorkspaceAccessError) {
          return fail(request, reply, error.statusCode, error.code, error.message);
        } else if (error instanceof BoardStreamLimit) {
          return fail(request, reply, 429, 'STREAM_LIMIT', 'Too many board event streams.');
        } else {
          return fail(request, reply, 503, 'UNAVAILABLE', 'Planner is unavailable.');
        }
      }
    },
  );
}
