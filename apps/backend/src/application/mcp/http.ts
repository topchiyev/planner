import {
  classifyInboundRequest, CLIENT_CAPABILITIES_META_KEY, createMcpHandler, isJsonContentType, McpServer,
  PROTOCOL_VERSION_META_KEY, type AuthInfo, type JSONRPCRequest, type McpRequestContext, type ServerCapabilities, type ServerEventBus,
} from '@modelcontextprotocol/server';
import { PLANNER_VERSION, relationshipCommands } from '@planner/contracts';
import type { McpReadSnapshot } from './read-tools.js';
import { oauthMetadata, protectedResourceMetadataPath, readScope, writeScope } from '../oauth/provider.js';

export const mcpPath = '/mcp';
export const mcpBodyLimit = 64 * 1024;
export const modernMcpVersion = '2026-07-28';
export const legacyMcpVersion = '2025-11-25';

export interface McpActor {
  generationId: string;
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  read?: McpReadSnapshot;
}

export interface McpSurface {
  register(server: McpServer, actor: McpActor, era: McpRequestContext['era']): void;
  capabilities?(era: McpRequestContext['era']): ServerCapabilities;
  admitListen?(actor: McpActor, notifications: unknown): boolean | Promise<boolean>;
  bus?: ServerEventBus;
}

const operatorCommands = new Set(['projects.delete', 'boards.delete', 'cards.purge', 'lists.clearTrash']);
const writeTools = new Set(Object.keys(relationshipCommands).filter((operation) => !operatorCommands.has(operation)).map((operation) => {
  const [collection, action] = operation.split('.');
  return collection.slice(0, -1) + '_' + action.replace(/[A-Z]/gu, (letter) => '_' + letter.toLowerCase());
}));

function requestsWorkspaceMutation(message: JSONRPCRequest) {
  return message.method === 'tools/call' && typeof message.params?.name === 'string' && writeTools.has(message.params.name);
}

export function mcpError(status: number, message: string, code = -32000) {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } });
}

function acceptedResponseTypes(header: string | null) {
  const permitted = new Set(header?.split(',').flatMap((entry) => {
    const [mime, ...parameters] = entry.split(';').map((part) => part.trim().toLowerCase());
    const quality = parameters.find((part) => part.startsWith('q='))?.slice(2);
    return quality === undefined || (Number(quality) > 0 && Number(quality) <= 1) ? [mime] : [];
  }));
  return permitted.has('application/json') && permitted.has('text/event-stream');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function createPlannerMcpHandler(origin: string, authorize: (token: string) => Promise<McpActor | null>, surface?: McpSurface) {
  const { challenge, resource } = oauthMetadata(origin);
  const metadataUrl = origin + protectedResourceMetadataPath;
  const stopping = new AbortController();
  let closing: Promise<void> | undefined;
  const actors = new WeakMap<AuthInfo, McpActor>();
  const sdk = createMcpHandler(({ era, authInfo }) => {
    const server = new McpServer({ name: 'Planner', version: PLANNER_VERSION }, {
      supportedProtocolVersions: [era === 'modern' ? modernMcpVersion : legacyMcpVersion],
      maxToolInputElements: 512,
      capabilities: surface?.capabilities?.(era),
    });
    const actor = authInfo && actors.get(authInfo);
    if (actor) surface?.register(server, actor, era);
    return server;
  }, { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: mcpBodyLimit, maxSubscriptions: 64,
    ...(surface?.bus && { bus: surface.bus }) });

  async function fetch(request: Request, options?: { parsedBody?: unknown }) {
    if (closing) return mcpError(503, 'Planner MCP is unavailable.');
    if (!isJsonContentType(request.headers.get('content-type'))) return mcpError(415, 'Expected application/json.');
    if (!acceptedResponseTypes(request.headers.get('accept'))) return mcpError(406, 'Accept application/json and text/event-stream.');
    const body = options?.parsedBody;
    const message = object(body);
    if (!message) return mcpError(400, 'Expected a single JSON-RPC message.', -32600);
    const headers = request.headers;
    const version = headers.get('mcp-protocol-version') ?? undefined;
    const method = headers.get('mcp-method') ?? undefined;
    const name = headers.get('mcp-name') ?? undefined;
    const route = classifyInboundRequest({ httpMethod: 'POST', protocolVersionHeader: version, mcpMethodHeader: method, mcpNameHeader: name, body });

    const token = /^Bearer ([A-Za-z0-9_-]{20,300})$/iu.exec(headers.get('authorization') ?? '')?.[1];
    const clean = new Headers(headers);
    clean.delete('authorization');
    clean.delete('cookie');
    const forwarded = new Request(resource, { method: 'POST', headers: clean, signal: AbortSignal.any([request.signal, stopping.signal]) });
    const dispatch = (authInfo?: AuthInfo) => sdk.fetch(forwarded, { parsedBody: body, authInfo });

    if (route.kind === 'reject') return dispatch();
    if (route.kind === 'legacy') {
      const envelope = object(object(message.params)?._meta);
      if (route.reason === 'response' || (envelope && (PROTOCOL_VERSION_META_KEY in envelope || CLIENT_CAPABILITIES_META_KEY in envelope))
        || method !== undefined || name !== undefined || message.method === 'server/discover' || message.method === 'subscriptions/listen') {
        return mcpError(400, 'Invalid MCP request for the legacy protocol.', -32600);
      }
      if ((route.reason !== 'initialize' || version !== undefined) && version !== legacyMcpVersion) {
        return mcpError(400, 'Expected MCP-Protocol-Version 2025-11-25.');
      }
    } else {
      if (route.classification.era !== 'modern' || route.classification.revision !== modernMcpVersion) return dispatch();
      if (route.messageKind === 'request' && (!version || !method)) return dispatch();
      if (route.messageKind === 'request' && route.message.method === 'server/discover') return dispatch();
    }

    let actor: McpActor | null = null;
    try { if (token) actor = await authorize(token); }
    catch { return mcpError(503, 'Planner MCP is unavailable.'); }
    if (!actor) return Response.json({ error: 'invalid_token' },
      { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': challenge } });
    if (closing) return mcpError(503, 'Planner MCP is unavailable.');

    const rpc = (route.kind === 'modern' ? route.message : message) as JSONRPCRequest;
    if (!actor.scopes.includes(writeScope) && requestsWorkspaceMutation(rpc)) {
      return Response.json({ error: 'insufficient_scope' }, { status: 403, headers: { 'Cache-Control': 'no-store',
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${readScope} ${writeScope}", resource_metadata="${metadataUrl}"` } });
    }
    if (rpc.method === 'subscriptions/listen'
      && !await surface?.admitListen?.(actor, rpc.params?.notifications)) return mcpError(403, 'Subscription is unavailable.');

    const authInfo: AuthInfo = { token: '', clientId: actor.clientId, scopes: actor.scopes,
      resource: new URL(resource), resourceMetadataUrl: metadataUrl };
    actors.set(authInfo, actor);
    if (closing) return mcpError(503, 'Planner MCP is unavailable.');
    return dispatch(authInfo);
  }

  return { fetch, close: () => closing ??= sdk.close().finally(() => stopping.abort()) };
}
