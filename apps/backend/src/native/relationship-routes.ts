import {
  boardDeleteReceipt, checklistDeleteReceipt, taskDeleteReceipt, labelDeleteReceipt, listDeleteReceipt, relationshipCommands, relationshipParentRevisionHeader, relationshipReads, removedRelationship, type RelationshipCommand, type RelationshipCommandInput, type RelationshipCommandOutput,
  type RelationshipRead, type RelationshipReadInput, type RelationshipReadOutput,
} from '@planner/contracts';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { readSessionCookie } from '../application/auth/credentials.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import { CommandJournal, type AfterCommandCommit } from '../application/command-journal/journal.js';
import { CommandConflict, CommandInputError } from '../application/command-journal/operation.js';
import { InvalidPageCursor } from '../application/pagination/cursor.js';
import { resolveBrowserWorkspace, WorkspaceAccessError } from '../application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../application/workspace/relationship-commands.js';
import { CardPlacementConflict, RelationshipError } from '../application/workspace/relationship-policy.js';
import { createRelationshipReads } from '../application/workspace/relationship-reads.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export interface WorkspaceRelationships {
  read<K extends RelationshipRead>(
    token: string, operation: K, input: RelationshipReadInput<K>,
  ): Promise<RelationshipReadOutput<K>>;
  execute<K extends RelationshipCommand>(
    token: string, actorId: string, operation: K, idempotencyKey: string, input: RelationshipCommandInput<K>,
  ): Promise<RelationshipCommandOutput<K>>;
}

export function createWorkspaceRelationships(
  database: Db, installationId: string, gate: CommandGate, now = () => new Date(), onCommitted?: () => void, afterCommit?: AfterCommandCommit,
): WorkspaceRelationships {
  const resolve = (token: string) => resolveBrowserWorkspace(database, installationId, token, now());
  return {
    read<K extends RelationshipRead>(token: string, operation: K, input: RelationshipReadInput<K>) {
      return gate.readSnapshot(async () => {
        const scope = await resolve(token);
        const handler = createRelationshipReads(database, scope)[operation] as (value: RelationshipReadInput<K>) => Promise<unknown>;
        return relationshipReads[operation].output.parse(await handler(input)) as RelationshipReadOutput<K>;
      });
    },
    async execute<K extends RelationshipCommand>(
      token: string, actorId: string, operation: K, idempotencyKey: string, input: RelationshipCommandInput<K>,
    ) {
      const journal = new CommandJournal(gate, database, installationId, {
        afterCommit,
        operations: createRelationshipJournalOperations(database, async (context) => {
          const scope = await resolve(token);
          if (scope.actor.id !== context.actorId || scope.generationId !== context.generationId) {
            throw new WorkspaceAccessError('session');
          }
          return scope;
        }, 'web', idempotencyKey),
      });
      const result = await journal.execute({ actorId, operationId: operation, idempotencyKey, input });
      onCommitted?.();
      return relationshipCommands[operation].output.parse(result) as RelationshipCommandOutput<K>;
    },
  };
}

export function createNativeWorkspaceRelationships(
  config: NativeInstallationConfig, gate: CommandGate, onCommitted?: () => void, afterCommit?: AfterCommandCommit,
): WorkspaceRelationships {
  async function withConnection<T>(use: (relationships: WorkspaceRelationships) => Promise<T>) {
    const client = await connectConfiguredNativeMongo(config);
    try {
      return await use(createWorkspaceRelationships(client.db(databaseName), config.installationId, gate, undefined, onCommitted, afterCommit));
    } finally { await client.close(); }
  }

  return {
    read: (token, operation, input) => withConnection((relationships) => relationships.read(token, operation, input)),
    execute: (token, actorId, operation, key, input) =>
      withConnection((relationships) => relationships.execute(token, actorId, operation, key, input)),
  };
}

function fail(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

function badInput(request: FastifyRequest, reply: FastifyReply) {
  return fail(request, reply, 422, 'INVALID_REQUEST', 'Check the affiliation request.');
}

function requestError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof CardPlacementConflict) {
    return reply.code(error.statusCode).send({ error: {
      code: error.code, message: error.message, requestId: request.id, fields: { current: error.current },
    } });
  }
  if (error instanceof WorkspaceAccessError || error instanceof RelationshipError) {
    return fail(request, reply, error.statusCode, error.code, error.message);
  }
  if (error instanceof CommandConflict) return fail(request, reply, 409, 'IDEMPOTENCY_CONFLICT', error.message);
  if (error instanceof InvalidPageCursor) return fail(request, reply, 422, 'INVALID_CURSOR', error.message);
  if (error instanceof CommandInputError) return badInput(request, reply);
  return fail(request, reply, 503, 'UNAVAILABLE', 'Planner is unavailable.');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerRelationshipRoutes(app: FastifyInstance, relationships: WorkspaceRelationships) {
  app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    routes.setErrorHandler((error: { statusCode?: number }, request, reply) =>
      error.statusCode && error.statusCode < 500 ? badInput(request, reply) : requestError(error, request, reply));
    const operations = [...Object.values(relationshipReads), ...Object.values(relationshipCommands)];
    for (const operation of operations) {
      routes.route({
        method: operation.method, url: operation.path, exposeHeadRoute: false, bodyLimit: 64 * 1024,
        async handler(request, reply) {
          const token = readSessionCookie(request.headers.cookie);
          const actor = request.plannerSession?.account;
          if (!request.plannerConnection?.clientAddress || !actor || !token) {
            return fail(request, reply, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
          }
          const params = request.params ?? {};
          const values = operation.kind === 'read' ? request.query : request.body === undefined ? {} : request.body;
          if (!object(params) || !object(values) || Object.keys(params).some((field) => Object.hasOwn(values, field))) {
            return badInput(request, reply);
          }
          try {
            if (operation.kind === 'read') {
              const input = operation.input.safeParse({ ...params, ...values });
              if (!input.success) return badInput(request, reply);
              return await relationships.read(token, operation.id, input.data as RelationshipReadInput<RelationshipRead>);
            }
            if (object(request.query) && Object.keys(request.query).length) return badInput(request, reply);
            const key = publicIdSchema.safeParse(request.headers['idempotency-key']);
            const header = request.headers['if-match'];
            const quoted = typeof header === 'string' ? /^"(0|[1-9]\d{0,15})"$/u.exec(header) : null;
            if (!key.success || Object.hasOwn(values, 'expectedRevision')) return badInput(request, reply);
            const argumentsForCommand = { ...params, ...values };
            if (operation.target === 'create') {
              if (header !== undefined) return badInput(request, reply);
            } else {
              if (!quoted) return badInput(request, reply);
              const revision = Number(quoted[1]);
              const expectedRevision = revision === 0 && operation.target === 'edge' ? null : revision;
              if (expectedRevision !== null && !revisionSchema.safeParse(expectedRevision).success) return badInput(request, reply);
              argumentsForCommand.expectedRevision = expectedRevision;
            }
            const input = operation.input.safeParse(argumentsForCommand);
            if (!input.success) return badInput(request, reply);
            const result = await relationships.execute(token, actor.id, operation.id, key.data,
              input.data as RelationshipCommandInput<RelationshipCommand>);
            if (operation.status === 204) {
              if (operation.id === 'boards.delete') {
                reply.header(relationshipParentRevisionHeader, boardDeleteReceipt.parse(result).data.parentRevision);
              } else if (operation.id === 'lists.delete') {
                reply.header(relationshipParentRevisionHeader, listDeleteReceipt.parse(result).data.parentRevision);
              } else if (operation.id === 'labels.delete') {
                reply.header(relationshipParentRevisionHeader, labelDeleteReceipt.parse(result).data.parentRevision);
              } else if (operation.id === 'checklists.delete') {
                reply.header(relationshipParentRevisionHeader, checklistDeleteReceipt.parse(result).data.parentRevision);
              } else if (operation.id === 'tasks.delete') {
                reply.header(relationshipParentRevisionHeader, taskDeleteReceipt.parse(result).data.checklist.revision);
              } else if (operation.target === 'edge') {
                const { parentRevision } = removedRelationship.parse(result).data;
                if (parentRevision !== null) reply.header(relationshipParentRevisionHeader, parentRevision);
              }
              return reply.code(204).send();
            }
            return reply.code(operation.status).send(result);
          } catch (error) {
            return requestError(error, request, reply);
          }
        },
      });
    }
  });
}
