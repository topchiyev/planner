import type { Tool } from '@modelcontextprotocol/server';
import { boardFilterIds, boardFilterKeys, boardRecipeSchema, mediaOperations, relationshipReads, workspaceOperations,
  type RelationshipRead, type RelationshipReadInput, type WorkspaceReadInput, type WorkspaceReadOperation } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { BoardEventCursors } from '../board-events/cursor.js';
import { CleanCommandRejection } from '../command-gate/gate.js';
import { createWorkspaceAuthorization, WorkspaceAccessError } from '../workspace/authorization.js';
import { createWorkspaceReads } from '../workspace/reads.js';
import { createWorkspaceReadBudget, createWorkspaceRecords } from '../workspace/records.js';
import { createRelationshipReads } from '../workspace/relationship-reads.js';
import type { WorkspaceActor } from '../workspace/authorization.js';
import type { Db } from 'mongodb';
import { z } from 'zod';

export interface McpReadPrincipal {
  readonly generationId: string;
  readonly clientId: string;
  readonly grantId: string;
  readonly actor: WorkspaceActor;
}

export type McpReadSnapshot = <T>(read: (database: Db, principal: McpReadPrincipal) => Promise<T>) => Promise<T | null>;

export class InvalidMcpRead extends CleanCommandRejection {}

export function workspaceSnapshot(database: Db, principal: McpReadPrincipal, cursors: BoardEventCursors) {
  const records = createWorkspaceRecords(database, principal.generationId, createWorkspaceReadBudget());
  const access = createWorkspaceAuthorization(database, principal.generationId, principal.actor, records);
  return { records, access, workspace: createWorkspaceReads(database, access, cursors, records),
    relationships: createRelationshipReads(database, access, records) };
}

type Snapshot = ReturnType<typeof workspaceSnapshot>;

export const mcpBoardTriageFilters = boardRecipeSchema.extend({
  context: workspaceOperations.boardCards.input.shape.context,
  limit: boardRecipeSchema.shape.limit.default(25),
  q: boardRecipeSchema.shape.q.default(''),
  unassigned: boardRecipeSchema.shape.unassigned.default(false),
  labelsAny: boardFilterIds.default([]), labelsNone: boardFilterIds.default([]),
  members: boardFilterIds.default([]), listIds: boardFilterIds.default([]),
});

function typedArguments(shape: z.ZodRawShape) {
  const fields: Record<string, z.core.$ZodType> = { ...shape };
  if (fields.limit) fields.limit = z.number().int().min(1).max(100).default(25);
  for (const field of ['favorite', 'unassigned', 'unread']) if (fields[field]) fields[field] = z.boolean().default(false);
  for (const field of boardFilterKeys) if (fields[field]) {
    fields[field] = boardFilterIds.default([]);
  }
  return z.strictObject(fields);
}

function toolName(id: string) {
  const [collection, action] = id.split('.');
  return collection.replace(/s$/u, '') + '_' + action.replace(/[A-Z]/gu, (letter) => '_' + letter.toLowerCase());
}

function readTool(id: string, description: string, input: z.ZodObject, output: z.ZodType,
  execute: (snapshot: Snapshot, parse: () => z.output<typeof input>, raw: Record<string, unknown>) => Promise<unknown>) {
  const wire = typedArguments(input.shape);
  return {
    id,
    declaration: {
      name: toolName(id), description,
      inputSchema: z.toJSONSchema(wire, { io: 'input', target: 'draft-07' }) as Tool['inputSchema'],
      outputSchema: z.toJSONSchema(output, { target: 'draft-07' }) as Tool['outputSchema'],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async read(snapshot: Snapshot, raw: Record<string, unknown>) {
      const result = await execute(snapshot, () => {
        const accepted = wire.safeParse(raw);
        if (!accepted.success) throw new InvalidMcpRead('Check the workspace query.');
        return accepted.data;
      }, raw);
      return output.parse(result) as Record<string, unknown>;
    },
  };
}

function workspace<K extends WorkspaceReadOperation>(key: K, description: string) {
  const op = workspaceOperations[key];
  return readTool(op.id, description, op.input, op.output, async ({ access, workspace }, parse, raw) => {
    if (key === 'boardCards') {
      // REST conceals a valid unreadable board even when its query is malformed.
      const id = publicIdSchema.safeParse(raw.id);
      if (!id.success) throw new WorkspaceAccessError('missing');
      const board = await access.requireBoard(id.data);
      return workspace.boardCards(parse() as WorkspaceReadInput<'boardCards'>, board);
    }
    const read = workspace[key] as (input: WorkspaceReadInput<K>) => Promise<unknown>;
    return read(parse() as WorkspaceReadInput<K>);
  });
}

function relationship<K extends RelationshipRead>(key: K, description: string) {
  const op = relationshipReads[key];
  return readTool(op.id, description, op.input, op.output, ({ relationships }, parse) => {
    const read = relationships[key] as (input: RelationshipReadInput<K>) => Promise<unknown>;
    return read(parse() as RelationshipReadInput<K>);
  });
}

export const mcpReadTools = [
  workspace('projectsList', 'List projects visible to the current account.'),
  workspace('projectGet', 'Read a project and its visible board summaries.'),
  workspace('boardsList', 'List visible boards in a project.'),
  workspace('boardGet', 'Read a visible board’s summary and permissions.'),
  workspace('boardWorkspace', 'Read the board setup, lists, labels, fields, and counts.'),
  workspace('boardCards', 'Search, filter, and page cards in a board, archive, or trash.'),
  workspace('cardGet', 'Read a visible card, its fields, people, and attachment metadata.'),
  workspace('boardLabels', 'List the labels available on a board.'),
  workspace('cardChecklists', 'List a card’s checklists and tasks, including visible related cards.'),
  workspace('cardComments', 'Page the visible comments on a card.'),
  workspace('boardActivity', 'Page the current board’s visible activity.'),
  workspace('cardActivity', 'Page the current card’s visible activity.'),
  workspace('notificationsList', 'Page the signed-in account’s visible inbox and unread count.'),
  relationship('boards.transferDestinations', 'List boards available as transfer destinations.'),
  relationship('fields.templateOptions', 'List the available field templates for a board.'),
  relationship('projects.managers', 'List the authorized manager roster for a project.'),
  relationship('projects.managerCandidates', 'List eligible project manager candidates.'),
  relationship('boards.members', 'List the authorized member roster for a board.'),
  relationship('boards.filterMembers', 'List eligible people for board card filters.'),
  relationship('boards.mentionMembers', 'List eligible people for mentions on a board.'),
  relationship('boards.memberCandidates', 'List eligible board member candidates.'),
] as const;

export function browserFiles(operation: string, result: Record<string, unknown>, origin: string) {
  if (operation === 'cards.get') {
    const { data } = workspaceOperations.cardGet.output.parse(result);
    return data.attachments.filter((file) => file.kind === 'file' && file.available).map((file) => ({
      id: file.id, name: file.name, browserUrl: origin + mediaOperations.attachmentDownload.path.replace(':id', file.id),
    }));
  }
  if (operation === 'projects.get') {
    const { data } = workspaceOperations.projectGet.output.parse(result);
    const files = new Map((data.backgrounds ?? []).map(({ id, name }) => [id, name]));
    if (data.background?.kind === 'image' && !files.has(data.background.id)) files.set(data.background.id, 'Project background');
    return [...files].map(([id, name]) => ({ id, name,
      browserUrl: origin + mediaOperations.backgroundDownload.path.replace(':id', data.id).replace(':backgroundId', id) }));
  }
  return [];
}
