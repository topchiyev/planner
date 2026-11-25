import { INTERNAL_ERROR, INVALID_PARAMS, ProtocolError, ResourceNotFoundError,
  type CallToolResult, type Resource, type Tool } from '@modelcontextprotocol/server';
import { workspaceOperations } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { MongoServerError } from 'mongodb';
import { z } from 'zod';
import type { BoardEventCursors } from '../board-events/cursor.js';
import { InvalidPageCursor, pageCursors, type CursorScope } from '../pagination/cursor.js';
import { WorkspaceAccessError } from '../workspace/authorization.js';
import { WorkspaceReadLimit } from '../workspace/records.js';
import type { McpBoardSubscriptions } from './board-subscriptions.js';
import type { McpSurface } from './http.js';
import { mcpMutationCatalog, mcpMutationNamed, mcpMutationWireSchema } from './mutation-catalog.js';
import { mcpMutationError } from './mutations.js';
import { browserFiles, InvalidMcpRead, mcpBoardTriageFilters, mcpReadTools, workspaceSnapshot, type McpReadPrincipal } from './read-tools.js';

const toolsByName = new Map(mcpReadTools.map((tool) => [tool.declaration.name, tool]));
const toolPageSize = 10;
const resourcePageSize = 25;
const resultBytes = 64 * 1024;
const writeDeclarations = mcpMutationCatalog.map((entry): Tool => ({
  name: entry.name, description: 'Planner workspace command: ' + entry.name.replaceAll('_', ' ') + '.',
  inputSchema: mcpMutationWireSchema(entry),
  annotations: { readOnlyHint: false, idempotentHint: true },
}));
const resourcePosition = z.strictObject({ kind: z.enum(['boards', 'cards']), id: publicIdSchema });

const resources = [
  { uriTemplate: 'planner://boards/{id}', name: 'Board', mimeType: 'application/json' },
  { uriTemplate: 'planner://cards/{id}', name: 'Card', mimeType: 'application/json' },
];

const prompts = [
  { name: 'board_status', description: 'Summarize the board’s current setup, counts and visible work.',
    instructions: 'Summarize the board status using the supplied Planner data. Call out gaps in the available data.' },
  { name: 'board_triage', description: 'Review the first page of visible cards for triage.',
    instructions: 'Summarize the visible cards that may need triage. Explain the basis for each observation and note that this is a single card page.' },
];
const promptInput = z.strictObject({ boardId: publicIdSchema });
const triageInput = promptInput.extend({ filters: z.string().max(12_000).optional() });

function triageFilters(raw?: string) {
  let input: unknown = {};
  if (raw !== undefined) {
    try { input = JSON.parse(raw); }
    catch { throw new InvalidMcpRead('Check the board triage filters.'); }
  }
  const filters = mcpBoardTriageFilters.safeParse(input);
  if (!filters.success) throw new InvalidMcpRead('Check the board triage filters.');
  return filters.data;
}

function bounded<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > resultBytes) throw new WorkspaceReadLimit();
  return result;
}

function cursorPosition<T>(scope: CursorScope, schema: z.ZodType<T>, cursor?: string) {
  if (cursor === undefined) return null;
  const position = schema.safeParse(pageCursors.decode(scope, cursor));
  if (!position.success) throw new InvalidPageCursor('The page cursor is invalid or no longer applies.');
  return position.data;
}

function rpcError(error: unknown, uri?: string): ProtocolError {
  if (error instanceof WorkspaceAccessError) {
    return uri && error.statusCode === 404 ? new ResourceNotFoundError(uri, error.message)
      : new ProtocolError(INVALID_PARAMS, error.message);
  }
  if (error instanceof InvalidMcpRead || error instanceof InvalidPageCursor || error instanceof WorkspaceReadLimit) {
    return new ProtocolError(INVALID_PARAMS, error.message);
  }
  return new ProtocolError(INTERNAL_ERROR, 'Planner MCP is unavailable.');
}

function toolError(error: unknown): CallToolResult {
  const code = error instanceof WorkspaceAccessError ? error.code
    : error instanceof InvalidPageCursor ? 'INVALID_CURSOR'
    : error instanceof InvalidMcpRead ? 'INVALID_REQUEST'
    : error instanceof WorkspaceReadLimit ? 'RESULT_TOO_LARGE'
    : 'UNAVAILABLE';
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message: rpcError(error).message }) }] };
}

function scopeOf(principal: McpReadPrincipal, era: string, operation: string): CursorScope {
  return {
    actorId: principal.actor.id, generationId: principal.generationId, operation, order: 'v1',
    query: [principal.actor.role, principal.clientId, principal.grantId, era],
  };
}

export function resourceUri(kind: z.infer<typeof resourcePosition>['kind'], id: string) {
  return 'planner://' + kind + '/' + id;
}

export function parseResourceUri(uri: string) {
  const [, kind, id] = /^planner:\/\/(boards|cards)\/([^/]+)$/u.exec(uri) ?? [];
  if (id?.length !== 36) return null;
  const resource = resourcePosition.safeParse({ kind, id });
  return resource.success ? resource.data : null;
}

export function createReadMcpSurface(
  origin: string, cursors: BoardEventCursors, includeWrites = false, boardSubscriptions?: McpBoardSubscriptions,
): McpSurface {
  const declarations = [...mcpReadTools.map(({ declaration }) => declaration), ...(includeWrites ? writeDeclarations : [])];
  const catalogPosition = z.number().int().positive().lt(declarations.length);
  const catalogScope = includeWrites ? 'mcp.tools.list.withWrites' : 'mcp.tools.list';
  return {
    boardSubscriptions,
    capabilities: (era) => ({
      tools: { listChanged: false },
      resources: { listChanged: false, ...(boardSubscriptions && { subscribe: era === 'modern' }) },
      prompts: { listChanged: false },
    }),
    register(mcp, actor, era) {
      const { server } = mcp;
      type Snapshot = ReturnType<typeof workspaceSnapshot>;

      async function snapshot<T>(operation: (snapshot: Snapshot, principal: McpReadPrincipal) => Promise<T>): Promise<T> {
        const value = await actor.read?.((database, principal) => operation(workspaceSnapshot(database, principal, cursors), principal));
        if (value === undefined || value === null) throw new WorkspaceAccessError('session');
        return value;
      }

      async function rpc<T>(operation: (snapshot: Snapshot, principal: McpReadPrincipal) => Promise<T>, uri?: string) {
        try { return await snapshot(operation); }
        catch (error) { throw rpcError(error, uri); }
      }

      server.setRequestHandler('tools/list', ({ params }) => rpc(async (_, principal) => {
        const scope = scopeOf(principal, era, catalogScope);
        const start = cursorPosition(scope, catalogPosition, params?.cursor) ?? 0;
        const end = start + toolPageSize;
        return { tools: declarations.slice(start, end),
          ...(end < declarations.length && { nextCursor: pageCursors.encode(scope, end) }) };
      }));

      // The board card list resolves board visibility before parsing search arguments, like REST.
      server.setRequestHandler('tools/call', async ({ params }) => {
        if (includeWrites && mcpMutationNamed(params.name)) {
          try {
            if (!actor.write) throw new WorkspaceAccessError('session');
            return await actor.write(params.name, params.arguments ?? {});
          } catch (error) {
            return mcpMutationError(error);
          }
        }
        const tool = toolsByName.get(params.name);
        if (!tool) throw new ProtocolError(INVALID_PARAMS, 'The requested tool is unavailable.');
        try {
          const result = await snapshot(async (reader) => {
            const data = await tool.read(reader, params.arguments ?? {});
            const files = browserFiles(tool.id, data, origin);
            const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(data) }];
            if (files.length) content.push({ type: 'text', text: JSON.stringify({ browserFiles: files }) });
            return bounded({ content, structuredContent: data });
          });
          return server.projectCallToolResult(result, tool.declaration.outputSchema);
        } catch (error) {
          return toolError(error);
        }
      });

      server.setRequestHandler('resources/templates/list', ({ params }) => rpc(async () => {
        if (params?.cursor !== undefined) throw new InvalidPageCursor('The page cursor is invalid or no longer applies.');
        return { resourceTemplates: resources };
      }));

      server.setRequestHandler('resources/list', ({ params }) => rpc(async ({ records, access }, principal) => {
        const scope = scopeOf(principal, era, 'mcp.resources.list');
        const start = cursorPosition(scope, resourcePosition, params?.cursor);
        const entries: { kind: 'boards' | 'cards'; id: string; name: string }[] = [];
        for (const kind of (start?.kind === 'cards' ? ['cards'] : ['boards', 'cards']) as ('boards' | 'cards')[]) {
          const stages = kind === 'boards' ? access.visibleBoardStages() : access.visibleCardStages();
          const rows = await records.aggregate<{ id: string; name: string }>(kind,
            start?.kind === kind ? { id: { $gt: start.id } } : {}, [
              ...stages, { $sort: { id: 1 } }, { $limit: resourcePageSize + 1 - entries.length }, { $project: { _id: 0, id: 1, name: 1 } },
            ], { maxTimeMS: 5_000 }).catch((error: unknown) => {
              if (error instanceof MongoServerError && error.code === 50) throw new WorkspaceReadLimit();
              throw error;
            });
          entries.push(...rows.map((row) => ({ kind, ...row })));
          if (entries.length > resourcePageSize) break;
        }
        const list = entries.slice(0, resourcePageSize);
        const last = list.at(-1);
        return bounded({
          resources: list.map(({ kind, id, name }): Resource => ({ name, uri: resourceUri(kind, id), mimeType: 'application/json' })),
          ...(last && entries.length > resourcePageSize && { nextCursor: pageCursors.encode(scope, { kind: last.kind, id: last.id }) }),
        });
      }));

      server.setRequestHandler('resources/read', ({ params: { uri } }) => {
        const resource = parseResourceUri(uri);
        if (!resource) throw new ProtocolError(INVALID_PARAMS, 'Choose a Planner board or card resource URI.');
        const { kind, id } = resource;
        return rpc(async ({ workspace }) => {
          const operation = kind === 'boards' ? workspaceOperations.boardGet : workspaceOperations.cardGet;
          const data = kind === 'boards' ? await workspace.boardGet({ id }) : await workspace.cardGet({ id });
          const dto = operation.output.parse(data);
          const files = browserFiles(operation.id, dto, origin);
          return bounded({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(dto) }],
            ...(files.length > 0 && { _meta: { browserFiles: files } }) });
        }, uri);
      });

      server.setRequestHandler('prompts/list', ({ params }) => rpc(async () => {
        if (params?.cursor !== undefined) throw new InvalidPageCursor('The page cursor is invalid or no longer applies.');
        return { prompts: prompts.map(({ name, description }) => ({ name, description, arguments: [
          { name: 'boardId', description: 'Planner board UUID.', required: true },
          ...(name === 'board_triage' ? [{ name: 'filters', description: 'JSON object of optional board-card filters: context, q, labelsAny, labelsNone, members, listIds, unassigned, and limit (1–100). UUID filters are arrays.' }] : []),
        ] })) };
      }));

      server.setRequestHandler('prompts/get', ({ params }) => rpc(async ({ workspace, access }) => {
        const prompt = prompts.find(({ name }) => name === params.name);
        const boardId = publicIdSchema.safeParse(params.arguments?.boardId);
        if (!prompt || !boardId.success) throw new InvalidMcpRead('Choose a board prompt and supply a board UUID.');
        const id = boardId.data;
        let data;
        if (prompt.name === 'board_status') {
          if (!promptInput.safeParse(params.arguments).success) throw new InvalidMcpRead('Check the board status arguments.');
          data = workspaceOperations.boardWorkspace.output.parse(await workspace.boardWorkspace({ id }));
        } else {
          const board = await access.requireBoard(id);
          const input = triageInput.safeParse(params.arguments);
          if (!input.success) throw new InvalidMcpRead('Check the board triage filters.');
          data = workspaceOperations.boardCards.output.parse(await workspace.boardCards({ id, ...triageFilters(input.data.filters) }, board));
        }
        return bounded({ description: prompt.description, messages: [
          { role: 'user' as const, content: { type: 'text' as const, text: prompt.instructions } },
          { role: 'user' as const, content: { type: 'text' as const, text: JSON.stringify(data) } },
        ] });
      }));
    },
  };
}
