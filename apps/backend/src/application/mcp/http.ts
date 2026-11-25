import {
  classifyInboundRequest, CLIENT_CAPABILITIES_META_KEY, createMcpHandler, isJsonContentType, InMemoryServerEventBus, INVALID_PARAMS, McpServer,
  PROTOCOL_VERSION_META_KEY, type AuthInfo, type JSONRPCRequest, type RequestId, type McpRequestContext, type ServerCapabilities, type ServerEventBus,
} from '@modelcontextprotocol/server';
import { setTimeout as delay } from 'node:timers/promises';
import type { McpBoardSubscription, McpBoardSubscriptions, McpListenAccess } from './board-subscriptions.js';
import { PLANNER_VERSION } from '@planner/contracts';
import type { McpReadSnapshot } from './read-tools.js';
import { oauthMetadata, protectedResourceMetadataPath, readScope, writeScope } from '../oauth/provider.js';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { mcpMutationNamed } from './mutation-catalog.js';

export const mcpPath = '/mcp';
export const mcpBodyLimit = 64 * 1024;
const maximumListenIdBytes = 4 * 1024;
// The pinned SDK repeats the id in its final frame. The remainder is fixed metadata and at most 16 board URIs.
export const maximumListenFrameBytes = 2 * maximumListenIdBytes + 4 * 1024;
export const modernMcpVersion = '2026-07-28';
export const legacyMcpVersion = '2025-11-25';

export interface McpActor {
  generationId: string;
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  read?: McpReadSnapshot;
  listen?: McpListenAccess;
  write?: (name: string, input: unknown) => Promise<CallToolResult>;
}

export interface McpSurface {
  register(server: McpServer, actor: McpActor, era: McpRequestContext['era']): void;
  capabilities?(era: McpRequestContext['era']): ServerCapabilities;
  admitListen?(actor: McpActor, notifications: unknown): boolean | Promise<boolean>;
  bus?: ServerEventBus;
  boardSubscriptions?: McpBoardSubscriptions;
}

function requestsWorkspaceMutation(message: Pick<JSONRPCRequest, 'method' | 'params'>) {
  return message.method === 'tools/call' && typeof message.params?.name === 'string' && mcpMutationNamed(message.params.name) !== undefined;
}

export function mcpError(status: number, message: string, code = -32000, id: RequestId | null = null) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } },
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
  type Admission = {
    token?: string;
    rpc: Pick<JSONRPCRequest, 'method' | 'params'> & { id?: RequestId };
    refusal?: Response;
    bus?: ServerEventBus;
    subscription?: McpBoardSubscription;
  };
  const responses = new WeakMap<Response, McpBoardSubscription>();
  const live = new Map<McpBoardSubscription, () => Promise<void>>();
  const boardSubscriptions = surface?.boardSubscriptions;
  const pending = new WeakMap<Request, Admission | 'discovery'>();
  const refuse = (admission: Admission, response: Response): never => {
    admission.refusal = response;
    throw new Error('Planner refused MCP admission.');
  };

  // The SDK validates modern routing headers before calling its factory. It only permits the
  // factory to return a server, so the fetch wrapper supplies the HTTP response for policy refusals.
  async function factory({ era, authInfo, requestInfo }: McpRequestContext) {
    if (!requestInfo) throw new Error('Missing MCP request context.');
    const admission = pending.get(requestInfo);
    if (!admission) throw new Error('Missing MCP admission.');
    let actor: McpActor | null = null;
    if (admission !== 'discovery') {
      if (!authInfo) throw new Error('Missing MCP authentication context.');
      const { token, rpc } = admission;
      try { if (token) actor = await authorize(token); }
      catch { return refuse(admission, mcpError(503, 'Planner MCP is unavailable.')); }
      if (!actor) return refuse(admission, Response.json({ error: 'invalid_token' },
        { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': challenge } }));
      if (!actor.scopes.includes(writeScope) && requestsWorkspaceMutation(rpc)) {
        return refuse(admission, Response.json({ error: 'insufficient_scope' }, { status: 403, headers: { 'Cache-Control': 'no-store',
          'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${readScope} ${writeScope}", resource_metadata="${metadataUrl}"` } }));
      }
      if (rpc.method === 'subscriptions/listen') {
        if (boardSubscriptions && admission.bus && era === 'modern') {
          if (requestInfo.headers.has('last-event-id')
            || (typeof rpc.id === 'string' && Buffer.byteLength(JSON.stringify(rpc.id), 'utf8') > maximumListenIdBytes)
            || Object.keys(rpc.params ?? {}).some((key) => key !== '_meta' && key !== 'notifications')) {
            return refuse(admission, mcpError(400, 'Invalid board subscription.', INVALID_PARAMS, rpc.id));
          }
          const result = await boardSubscriptions.subscribe(actor, rpc.params?.notifications, admission.bus, requestInfo.signal);
          if (result.kind === 'invalid') return refuse(admission, mcpError(400, 'Invalid board subscription.', INVALID_PARAMS, rpc.id));
          if (result.kind === 'limit') return refuse(admission, mcpError(429, 'Too many board subscriptions.', undefined, rpc.id));
          if (result.kind !== 'accepted') return refuse(admission, mcpError(403, 'Subscription is unavailable.', undefined, rpc.id));
          admission.subscription = result.subscription;
        } else if (!await surface?.admitListen?.(actor, rpc.params?.notifications)) {
          return refuse(admission, mcpError(403, 'Subscription is unavailable.'));
        }
      }
      if (closing) return refuse(admission, mcpError(503, 'Planner MCP is unavailable.'));
      authInfo.clientId = actor.clientId;
      authInfo.scopes = actor.scopes;
    }
    const server = new McpServer({ name: 'Planner', version: PLANNER_VERSION }, {
      supportedProtocolVersions: [era === 'modern' ? modernMcpVersion : legacyMcpVersion],
      maxToolInputElements: 512,
      capabilities: surface?.capabilities?.(era),
    });
    if (actor) surface?.register(server, actor, era);
    return server;
  }
  const sdk = createMcpHandler(factory, { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: mcpBodyLimit, maxSubscriptions: 64,
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
      if (route.message.method === 'server/discover') {
        if (route.messageKind !== 'request') return mcpError(400, 'Discovery requires a request ID.', -32600);
        pending.set(forwarded, 'discovery');
        return dispatch();
      }
    }

    const rpc = (route.kind === 'modern' ? route.message : message) as Admission['rpc'];
    // The pinned SDK owns validation and framing. Each production listen owns a separate bus and one SDK router.
    const bus = boardSubscriptions && route.kind === 'modern' && route.messageKind === 'request' && rpc.method === 'subscriptions/listen'
      ? new InMemoryServerEventBus() : undefined;
    const scoped = bus && createMcpHandler(factory, {
      legacy: 'reject', maxRequestBodySize: mcpBodyLimit, maxSubscriptions: 1, keepAliveMs: 0, bus,
    });
    const admission: Admission = { token, rpc, bus };
    pending.set(forwarded, admission);
    const authInfo: AuthInfo = { token: '', clientId: '', scopes: [],
      resource: new URL(resource), resourceMetadataUrl: metadataUrl };
    try {
      const response = scoped ? await scoped.fetch(forwarded, { parsedBody: body, authInfo }) : await dispatch(authInfo);
      const subscription = admission.subscription;
      if (scoped && subscription && !admission.refusal && response.body && response.headers.get('content-type')?.startsWith('text/event-stream')) {
        responses.set(response, subscription);
        live.set(subscription, () => scoped.close());
        void subscription.finished.then(async () => {
          live.delete(subscription);
          await scoped.close();
        }).catch(() => undefined);
        return response;
      }
      subscription?.release();
      await scoped?.close();
      return admission.refusal ?? response;
    } catch (error) {
      admission.subscription?.release();
      await scoped?.close();
      throw error;
    } finally { pending.delete(forwarded); }
  }

  return {
    fetch,
    subscriptionFor: (response: Response) => responses.get(response),
    close: () => closing ??= (async () => {
      await sdk.close();
      await Promise.all([...live].map(async ([subscription, end]) => {
        subscription.quiesce();
        await end();
        const timeout = new AbortController();
        const completed = await Promise.race([
          subscription.finished.then(() => true),
          delay(2000, false, { ref: false, signal: timeout.signal }),
        ]).finally(() => timeout.abort());
        if (!completed) subscription.release();
      }));
    })().finally(() => stopping.abort()),
  };
}
