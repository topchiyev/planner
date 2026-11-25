import type { ServerEventBus } from '@modelcontextprotocol/server';
import { signedInt64TextSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { createBoardEventStore } from '../board-events/store.js';
import type { OutboxSignal } from '../command-journal/journal.js';
import type { OAuthRevocation } from '../oauth/storage.js';
import { createWorkspaceAuthorization } from '../workspace/authorization.js';
import type { McpActor } from './http.js';
import { parseResourceUri, resourceUri } from './read-surface.js';
import type { McpReadPrincipal } from './read-tools.js';

const maximumBoards = 16;
const maximumStreams = 64;
const maximumUserStreams = 8;
const maximumGrantStreams = 4;
const defaultHeartbeatMs = 20_000;

export interface McpListenProof extends McpReadPrincipal {
  readonly expiresAtMs: number;
  valid(): boolean;
}

export interface McpListenAccess {
  readonly tokenId: string;
  read<T>(operation: (database: Db, proof: McpListenProof) => Promise<T>): Promise<T | null>;
  currentUnderWriter(database: Db): Promise<McpListenProof | null>;
}

export interface McpBoardSubscription {
  readonly signal: AbortSignal;
  readonly finished: Promise<void>;
  attach(heartbeat: () => boolean): void;
  send(frame: 'ack' | 'update' | 'final', write: () => boolean, uri?: string): Promise<boolean>;
  release(graceful?: boolean): void;
}

type Subscriber = {
  identity: Pick<McpActor, 'generationId' | 'userId' | 'grantId'>;
  access: McpListenAccess;
  boards: Set<string>;
  high: Map<string, bigint>;
  pending: Set<string>;
  bus: ServerEventBus;
  abort: AbortController;
  deadline?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  pump?: NodeJS.Immediate;
  writeHeartbeat?: () => boolean;
  acknowledged: boolean;
  inFlight?: string;
  writing: boolean;
  closed: boolean;
};

function listenBoards(notifications: unknown): Set<string> | null {
  if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications) ||
    Object.keys(notifications).length !== 1 || !('resourceSubscriptions' in notifications)) return null;
  const uris = notifications.resourceSubscriptions;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > maximumBoards) return null;
  const boards = new Set<string>();
  for (const uri of uris) {
    if (typeof uri !== 'string') return null;
    const resource = parseResourceUri(uri);
    if (!resource || resource.kind !== 'boards' || boards.has(resource.id)) return null;
    boards.add(resource.id);
  }
  return boards;
}

export function createMcpBoardSubscriptions({ now = Date.now, heartbeatMs = defaultHeartbeatMs } = {}) {
  const subscribers = new Set<Subscriber>();
  let stopped = false;

  function disconnect(subscriber: Subscriber, graceful = false) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscribers.delete(subscriber);
    clearTimeout(subscriber.deadline);
    clearInterval(subscriber.heartbeat);
    clearImmediate(subscriber.pump);
    subscriber.pending.clear();
    if (!graceful) subscriber.abort.abort();
  }

  async function requireBoards(database: Db, proof: McpListenProof, boards: ReadonlySet<string>) {
    const access = createWorkspaceAuthorization(database, proof.generationId, proof.actor);
    for (const id of boards) await access.requireBoard(id);
  }

  function schedule(subscriber: Subscriber) {
    if (subscriber.closed || !subscriber.acknowledged || subscriber.writing || subscriber.inFlight || subscriber.pump || !subscriber.pending.size) return;
    subscriber.pump = setImmediate(() => {
      subscriber.pump = undefined;
      const board = subscriber.pending.values().next().value;
      if (subscriber.closed || subscriber.writing || !board) return;
      subscriber.pending.delete(board);
      const uri = subscriber.inFlight = resourceUri('boards', board);
      try { subscriber.bus.publish({ kind: 'resource_updated', uri }); }
      catch { disconnect(subscriber); }
    });
    subscriber.pump.unref();
  }

  async function writeAuthorized(subscriber: Subscriber, write: () => boolean) {
    if (subscriber.closed || subscriber.writing) return false;
    subscriber.writing = true;
    try {
      const result = await subscriber.access.read(async (database, proof) => {
        await requireBoards(database, proof, subscriber.boards);
        if (subscriber.closed || stopped || !proof.valid()) return false;
        // The socket handoff is synchronous. A backpressured sink is dropped without waiting under the lease.
        try { return write(); } catch { return false; }
      });
      if (result === true) return true;
    } catch { /* Loss of access or readiness closes this stream. */ }
    finally { subscriber.writing = false; }
    disconnect(subscriber);
    return false;
  }

  async function revalidate(database: Db, applies: (subscriber: Subscriber) => boolean) {
    await Promise.all([...subscribers].filter(applies).map(async (subscriber) => {
      try {
        const proof = await subscriber.access.currentUnderWriter(database);
        if (proof) {
          await requireBoards(database, proof, subscriber.boards);
          if (proof.valid()) return;
        }
      } catch { /* A revoked scope is terminal even during a queued regrant. */ }
      disconnect(subscriber);
    }));
  }

  return {
    async subscribe(actor: McpActor, notifications: unknown, bus: ServerEventBus, disconnected: AbortSignal) {
      const boards = listenBoards(notifications);
      if (!boards) return { kind: 'invalid' } as const;
      const access = actor.listen;
      if (!access || stopped || disconnected.aborted) return { kind: 'unavailable' } as const;
      let userStreams = 0;
      let grantStreams = 0;
      for (const { identity } of subscribers) {
        if (identity.generationId === actor.generationId && identity.userId === actor.userId) {
          userStreams += 1;
          if (identity.grantId === actor.grantId) grantStreams += 1;
        }
      }
      if (subscribers.size >= maximumStreams || userStreams >= maximumUserStreams || grantStreams >= maximumGrantStreams) {
        return { kind: 'limit' } as const;
      }

      const subscriber: Subscriber = {
        identity: { generationId: actor.generationId, userId: actor.userId, grantId: actor.grantId },
        access, boards, bus, high: new Map(), pending: new Set(), abort: new AbortController(),
        acknowledged: false, writing: false, closed: false,
      };
      subscribers.add(subscriber);
      const cancel = () => disconnect(subscriber);
      disconnected.addEventListener('abort', cancel, { once: true });
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      let released = false;
      function release(graceful = false) {
        if (released) return;
        released = true;
        disconnect(subscriber, graceful);
        disconnected.removeEventListener('abort', cancel);
        finish();
      }
      try {
        const admitted = await access.read(async (database, proof) => {
          await requireBoards(database, proof, boards);
          for (const id of boards) subscriber.high.set(id, await createBoardEventStore(database, proof.generationId, id).highWater());
          if (subscriber.closed || stopped || !proof.valid()) return false;
          // The high-water values and live pending registration become visible under the same read lease.
          subscriber.deadline = setTimeout(cancel, proof.expiresAtMs - now());
          subscriber.deadline.unref();
          return true;
        });
        if (!admitted || subscriber.closed) {
          release();
          return { kind: 'denied' } as const;
        }
      } catch {
        release();
        return { kind: 'denied' } as const;
      }

      const subscription: McpBoardSubscription = {
        signal: subscriber.abort.signal,
        finished,
        attach(heartbeat) { subscriber.writeHeartbeat = heartbeat; },
        async send(frame, write, uri) {
          const valid = frame === 'ack' ? !subscriber.acknowledged
            : subscriber.acknowledged && (frame === 'final' || (uri !== undefined && uri === subscriber.inFlight));
          if (!valid || !await writeAuthorized(subscriber, write)) {
            release();
            return false;
          }
          if (frame === 'ack') {
            subscriber.acknowledged = true;
            subscriber.heartbeat = setInterval(() => {
              const heartbeat = subscriber.writeHeartbeat;
              if (!heartbeat || subscriber.closed || subscriber.writing || subscriber.inFlight || subscriber.pending.size) return;
              void writeAuthorized(subscriber, heartbeat).finally(() => schedule(subscriber));
            }, heartbeatMs);
            subscriber.heartbeat.unref();
          }
          if (frame === 'update') subscriber.inFlight = undefined;
          if (frame !== 'final') schedule(subscriber);
          return true;
        },
        release,
      };
      return { kind: 'accepted', subscription } as const;
    },

    accept(signal: OutboxSignal) {
      const parsed = signedInt64TextSchema.safeParse(signal.sequence);
      if (!parsed.success) return;
      const sequence = BigInt(parsed.data);
      for (const subscriber of subscribers) {
        if (subscriber.identity.generationId !== signal.generationId) continue;
        const high = subscriber.high.get(signal.boardId);
        if (high === undefined || sequence <= high) continue;
        subscriber.high.set(signal.boardId, sequence);
        subscriber.pending.add(signal.boardId);
        schedule(subscriber);
      }
    },
    revalidateActor(database: Db, id: string) {
      return revalidate(database, ({ identity }) => identity.userId === id);
    },
    revalidateBoards(database: Db, generationId: string, boards: ReadonlySet<string>) {
      return revalidate(database, (subscriber) => subscriber.identity.generationId === generationId
        && [...subscriber.boards].some((id) => boards.has(id)));
    },
    revoked(identity: OAuthRevocation) {
      for (const subscriber of subscribers) {
        if (identity.generationId !== subscriber.identity.generationId) continue;
        if ('grantId' in identity ? identity.grantId === subscriber.identity.grantId : identity.tokenId === subscriber.access.tokenId) {
          disconnect(subscriber);
        }
      }
    },
    disconnectAll() {
      for (const subscriber of subscribers) disconnect(subscriber);
    },
    stop() {
      stopped = true;
      for (const subscriber of subscribers) disconnect(subscriber);
    },
  };
}

export type McpBoardSubscriptions = ReturnType<typeof createMcpBoardSubscriptions>;
