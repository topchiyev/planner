import { toWebRequest } from '@modelcontextprotocol/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mcpBodyLimit, mcpError, type createPlannerMcpHandler } from '../application/mcp/http.js';

const maximumFrameBytes = 4 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function frameOf(bytes: Uint8Array): { kind: 'ack' | 'update' | 'final'; uri?: string } | null {
  if (bytes.byteLength > maximumFrameBytes) return null;
  try {
    const [, data] = /^event: message\ndata: ([^\r\n]+)\n\n$/u.exec(decoder.decode(bytes)) ?? [];
    if (!data) return null;
    const frame = JSON.parse(data);
    if (frame.jsonrpc !== '2.0') return null;
    if (frame.method === 'notifications/subscriptions/acknowledged') return { kind: 'ack' };
    if (frame.method === 'notifications/resources/updated' && typeof frame.params?.uri === 'string') {
      return { kind: 'update', uri: frame.params.uri };
    }
    if (frame.result?.resultType === 'complete') return { kind: 'final' };
    return null;
  } catch { return null; }
}

export async function serveNativeMcpSubscription(
  handler: ReturnType<typeof createPlannerMcpHandler>, incoming: IncomingMessage, outgoing: ServerResponse, body: unknown,
) {
  const request = new AbortController();
  const disconnect = () => request.abort();
  outgoing.once('close', disconnect);
  if (outgoing.destroyed) disconnect();
  try {
    const web = await toWebRequest(incoming, body, { signal: request.signal, maxRequestBodySize: mcpBodyLimit });
    const response = await handler.fetch(web, { parsedBody: body });
    const subscription = handler.subscriptionFor(response);
    const headers = { ...Object.fromEntries(response.headers), 'cache-control': 'no-store' };
    if (!subscription || !response.body) {
      if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        outgoing.destroy();
        return;
      }
      const payload = await response.text();
      if (!request.signal.aborted) outgoing.writeHead(response.status, headers).end(payload);
      return;
    }

    const abort = () => outgoing.destroy();
    subscription.signal.addEventListener('abort', abort, { once: true });
    if (subscription.signal.aborted) abort();
    const reader = response.body.getReader();
    let graceful = false;
    function write(chunk: Uint8Array | string) {
      if (outgoing.destroyed || outgoing.writableEnded || outgoing.writableNeedDrain || outgoing.writableLength > 0) return false;
      return typeof chunk === 'string' ? outgoing.write(chunk, 'utf8') : outgoing.write(chunk);
    }

    subscription.attach(() => write(': keepalive\n\n'));
    try {
      // The pinned SDK emits one frame per chunk. Only those recognized frames reach the protected socket.
      while (!request.signal.aborted && !subscription.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        const frame = frameOf(value);
        if (!frame) break;
        const sent = await subscription.send(frame.kind, () => {
          if (frame.kind === 'ack' && !outgoing.destroyed) outgoing.writeHead(response.status, headers);
          return write(value);
        }, frame.uri);
        if (!sent) break;
        if (frame.kind === 'final') {
          graceful = true;
          break;
        }
      }
    } finally {
      subscription.signal.removeEventListener('abort', abort);
      if (graceful) outgoing.end();
      else outgoing.destroy();
      subscription.release(graceful);
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    if (outgoing.headersSent || request.signal.aborted || outgoing.destroyed) outgoing.destroy();
    else {
      const unavailable = mcpError(503, 'Planner MCP is unavailable.');
      outgoing.writeHead(unavailable.status, Object.fromEntries(unavailable.headers)).end(await unavailable.text());
    }
  } finally { outgoing.removeListener('close', disconnect); }
}
