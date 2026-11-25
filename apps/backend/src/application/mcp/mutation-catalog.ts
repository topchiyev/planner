import {
  mediaBackgroundIdsSchema, mediaIdSchema, mediaLinkInputSchema, mediaMutationSchema, mediaOperations, mediaRenameSchema, relationshipCommands,
  type RelationshipCommand,
} from '@planner/contracts';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { z } from 'zod';
import { CommandInputError } from '../command-journal/operation.js';
import { relationshipDeletionSummary } from '../workspace/relationship-receipts.js';

const excluded = new Set(['projects.delete', 'boards.delete', 'cards.purge', 'lists.clearTrash']);
const snakeName = (operation: string) => {
  const [collection, action] = operation.split('.');
  return collection.slice(0, -1) + '_' + action.replace(/[A-Z]/gu, (letter) => '_' + letter.toLowerCase());
};

const metadataInputs = {
  addLink: mediaIdSchema.extend(mediaLinkInputSchema.shape),
  renameAttachment: mediaIdSchema.extend(mediaRenameSchema.shape),
  removeAttachment: mediaIdSchema,
  removeBackground: mediaBackgroundIdsSchema,
};
export type McpMediaMutation = keyof typeof metadataInputs;

type Mutation = { kind: 'relationship'; operation: RelationshipCommand } | { kind: 'media'; operation: McpMediaMutation };
type Definition = Mutation & {
  name: string;
  input: z.ZodType;
  allowImportedRevision: boolean;
};

function definition(mutation: Mutation, operationId: string, input: z.ZodType, edge: boolean): Definition {
  const shape = input instanceof z.ZodPipe ? input.in : input;
  const allowImportedRevision = edge && shape instanceof z.ZodObject
    && shape.shape.expectedRevision?.safeParse(null).success === true;
  return Object.freeze({ ...mutation, name: snakeName(operationId), input, allowImportedRevision });
}

export const mcpMutationCatalog = Object.freeze([
  ...Object.values(relationshipCommands).filter(({ id }) => !excluded.has(id)).map(({ id, target, input }) =>
    definition({ kind: 'relationship', operation: id }, id, input, target === 'edge')),
  ...Object.entries(metadataInputs).map(([name, schema]) => {
    const operation = name as McpMediaMutation;
    return definition({ kind: 'media', operation }, mediaOperations[operation].id,
      schema.extend({ expectedRevision: revisionSchema }), false);
  }),
]);

const byName = new Map(mcpMutationCatalog.map((entry) => [entry.name, entry]));
if (byName.size !== mcpMutationCatalog.length) throw new Error('Duplicate MCP mutation name.');

export function mcpMutationNamed(name: string) { return byName.get(name); }

export function mcpMutationWireSchema(entry: Definition) {
  const options = { io: 'input', target: 'draft-07', unrepresentable: 'any' } as const;
  const { $schema: _idSchema, ...idempotencyKey } = z.toJSONSchema(publicIdSchema, options);
  interface InputSchema {
    $schema?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    anyOf?: InputSchema[];
  }
  function addEnvelope(schema: InputSchema): Record<string, unknown> {
    const { $schema: _schema, anyOf, properties, required, ...inputSchema } = schema;
    if (anyOf) return { ...inputSchema, anyOf: anyOf.map(addEnvelope) };
    return { ...inputSchema, properties: { ...properties, idempotencyKey,
      ...(entry.allowImportedRevision && { expectedRevision: { anyOf: [properties?.expectedRevision, { const: 0 }] } }) },
      required: [...(required ?? []), 'idempotencyKey'], additionalProperties: false };
  }
  return addEnvelope(z.toJSONSchema(entry.input, options));
}

export function parseMcpMutation(entry: Definition, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CommandInputError('Invalid command arguments.');
  const { idempotencyKey, ...args } = raw as Record<string, unknown>;
  const key = publicIdSchema.safeParse(idempotencyKey);
  const input = entry.input.safeParse(entry.allowImportedRevision && args.expectedRevision === 0
    ? { ...args, expectedRevision: null } : args);
  if (!key.success || !input.success) throw new CommandInputError('Invalid command arguments.');
  return { idempotencyKey: key.data, input: input.data };
}

export function mcpRelationshipReceipt(operation: RelationshipCommand, result: unknown) {
  if (relationshipCommands[operation].status !== 204) return relationshipCommands[operation].output.parse(result);
  return { data: { acknowledged: true, ...relationshipDeletionSummary(operation, result) } };
}

export function mcpMediaReceipt(operation: McpMediaMutation, result: unknown) {
  const validated = mediaMutationSchema.parse(result);
  return mediaOperations[operation].method === 'DELETE'
    ? { data: { acknowledged: true, parentRevision: validated.data.parent.revision } }
    : validated;
}
