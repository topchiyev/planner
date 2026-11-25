import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Db } from 'mongodb';
import type { CommandGate } from '../command-gate/gate.js';
import { CommandJournal, type AfterCommandCommit } from '../command-journal/journal.js';
import { CommandConflict, CommandInputError, type CommandContext } from '../command-journal/operation.js';
import type { McpCommandAttribution } from '../command-journal/records.js';
import { MediaRejection } from '../media/errors.js';
import type { MediaService } from '../media/service.js';
import { WorkspaceReadOnly } from '../migration/cutover.js';
import { WorkspaceAccessError, type WorkspaceAuthorization } from '../workspace/authorization.js';
import { createRelationshipJournalOperations } from '../workspace/relationship-commands.js';
import { mcpMediaReceipt, mcpMutationNamed, mcpRelationshipReceipt, parseMcpMutation } from './mutation-catalog.js';
import { CardPlacementConflict, RelationshipError } from '../workspace/relationship-policy.js';

const maximumResultBytes = 64 * 1024;

class MutationResultTooLarge extends CommandInputError {
  constructor() { super('The command would produce a result too large for MCP.'); }
}

interface MutationServices {
  database: Db;
  installationId: string;
  gate: CommandGate;
  actorId: string;
  resolve(context: Pick<CommandContext, 'actorId' | 'generationId'>): Promise<WorkspaceAuthorization>;
  media: Pick<MediaService, 'mutateMetadata'>;
  attribution: McpCommandAttribution;
  afterCommit?: AfterCommandCommit;
  onCommitted?: () => void;
}

function complete(result: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function large(result: CallToolResult) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumResultBytes;
}

export async function executeMcpMutation(services: MutationServices, name: string, raw: unknown): Promise<CallToolResult> {
  const descriptor = mcpMutationNamed(name);
  if (!descriptor) throw new CommandInputError('The requested tool is unavailable.');
  const { idempotencyKey, input } = parseMcpMutation(descriptor, raw);
  const { database, gate, installationId, resolve, actorId, attribution } = services;
  let result: CallToolResult;
  if (descriptor.kind === 'relationship') {
    const { operation: operationId } = descriptor;
    // Keep REST as the default origin when finishing an older web intent without provenance.
    const handler = createRelationshipJournalOperations(database, resolve, 'web', idempotencyKey)[operationId];
    const projected = (value: unknown) => complete(mcpRelationshipReceipt(operationId, value) as Record<string, unknown>);
    const journal = new CommandJournal(gate, database, installationId, {
      attribution, afterCommit: services.afterCommit,
      operations: { [operationId]: {
        ...handler,
        async plan(context, request) {
          const plan = await handler.plan(context, request);
          if (large(projected(plan.result))) throw new MutationResultTooLarge();
          return plan;
        },
      } },
    });
    result = projected(await journal.execute({ actorId, operationId, idempotencyKey, input }));
  } else {
    const { id, backgroundId, expectedRevision, name, url } = input as {
      id: string; backgroundId?: string; expectedRevision: number; name?: string; url?: string;
    };
    result = complete(mcpMediaReceipt(descriptor.operation, await services.media.mutateMetadata(
      resolve, actorId, { operation: descriptor.operation, id, backgroundId, expectedRevision, key: idempotencyKey },
      { name, url }, attribution,
    )));
  }
  services.onCommitted?.();
  // A former REST invocation can have an already committed result above the MCP response bound.
  return large(result) ? complete({ data: { acknowledged: true, resultOmitted: true } }) : result;
}

export function mcpMutationError(error: unknown): CallToolResult {
  let code = 'UNAVAILABLE';
  let message = 'Planner MCP is unavailable.';
  if (error instanceof MutationResultTooLarge) {
    code = 'RESULT_TOO_LARGE';
    message = error.message;
  } else if (error instanceof CommandInputError) {
    code = 'INVALID_REQUEST';
    message = 'Check the command arguments.';
  } else if (error instanceof WorkspaceAccessError || error instanceof RelationshipError
    || error instanceof CommandConflict || error instanceof WorkspaceReadOnly) {
    code = error.code;
    message = error.message;
  } else if (error instanceof MediaRejection && error.kind === 'revision') {
    code = 'REVISION_CONFLICT';
    message = 'The resource revision changed.';
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, ...(error instanceof CardPlacementConflict && { fields: { current: error.current } }) }) }] };
}
