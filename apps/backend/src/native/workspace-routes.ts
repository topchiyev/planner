import { workspaceOperations, type WorkspaceReadInput, type WorkspaceReadOperation, type WorkspaceReadOutput } from '@planner/contracts';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { readSessionCookie } from '../application/auth/credentials.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import { InvalidPageCursor } from '../application/pagination/cursor.js';
import { resolveBrowserWorkspace, WorkspaceAccessError } from '../application/workspace/authorization.js';
import { createWorkspaceReads } from '../application/workspace/reads.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export interface WorkspaceReader {
  read<K extends WorkspaceReadOperation>(token: string, operation: K, input: WorkspaceReadInput<K>): Promise<WorkspaceReadOutput<K>>;
}

export function createWorkspaceReader(database: Db, installationId: string, gate: CommandGate, now = () => new Date()): WorkspaceReader {
  return {
    read<K extends WorkspaceReadOperation>(token: string, operation: K, input: WorkspaceReadInput<K>) {
      return gate.readSnapshot(async () => {
        const scope = await resolveBrowserWorkspace(database, installationId, token, now());
        const handler = createWorkspaceReads(database, scope)[operation] as (value: WorkspaceReadInput<K>) => Promise<unknown>;
        const output = await handler(input);
        return workspaceOperations[operation].output.parse(output) as WorkspaceReadOutput<K>;
      });
    },
  };
}

export function createNativeWorkspaceReader(config: NativeInstallationConfig, gate: CommandGate): WorkspaceReader {
  return {
    async read(token, operation, input) {
      const client = await connectConfiguredNativeMongo(config);
      try {
        return await createWorkspaceReader(client.db(databaseName), config.installationId, gate).read(token, operation, input);
      } finally { await client.close(); }
    },
  };
}

function fail(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

export function registerWorkspaceRoutes(app: FastifyInstance, reader: WorkspaceReader) {
  app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    for (const key of Object.keys(workspaceOperations) as WorkspaceReadOperation[]) {
      const { method, path, input } = workspaceOperations[key];
      routes.route({
        method, url: path, exposeHeadRoute: false,
        async handler(request, reply) {
          const token = readSessionCookie(request.headers.cookie);
          if (!request.plannerConnection?.clientAddress || !request.plannerSession || !token) {
            return fail(request, reply, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
          }
          const params = (request.params ?? {}) as Record<string, unknown>;
          const query = (request.query ?? {}) as Record<string, unknown>;
          const parsed = input.safeParse({ ...params, ...query });
          if (!parsed.success || Object.keys(params).some((field) => Object.hasOwn(query, field))) {
            return fail(request, reply, 422, 'INVALID_REQUEST', 'Check the workspace query.');
          }
          try {
            return await reader.read(token, key, parsed.data);
          } catch (error) {
            if (error instanceof WorkspaceAccessError) return fail(request, reply, error.statusCode, error.code, error.message);
            if (error instanceof InvalidPageCursor) return fail(request, reply, 422, 'INVALID_CURSOR', error.message);
            return fail(request, reply, 503, 'UNAVAILABLE', 'Planner is unavailable.');
          }
        },
      });
    }
  });
}
