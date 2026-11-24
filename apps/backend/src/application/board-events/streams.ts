import type { BoardEventFrame } from '@planner/contracts';
import { signedInt64TextSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { CleanCommandRejection, type CommandGate } from '../command-gate/gate.js';
import type { OutboxSignal } from '../command-journal/journal.js';
import { resolveBrowserWorkspace, WorkspaceAccessError } from '../workspace/authorization.js';
import type { BoardEventCursors, BoardEventScope } from './cursor.js';
import { createBoardEventStore, projectBoardEvent } from './store.js';

export const boardHeartbeatMs = 20_000;
const maximumStreams = 256;
const maximumActorStreams = 8;

export class BoardStreamLimit extends CleanCommandRejection {}
export class BoardStreamUnavailable extends CleanCommandRejection {}

export interface BoardStreamTransport {
  begin(): void;
  frame(frame: BoardEventFrame, cursor?: string): boolean;
  heartbeat(): boolean;
  close(abort: boolean): void;
}

interface Subscriber {
  scope: BoardEventScope;
  token: string;
  transport: BoardStreamTransport;
  abort: AbortSignal;
  disconnect: () => void;
  timer?: NodeJS.Timeout;
  pending?: NodeJS.Immediate;
  running: boolean;
  closed: boolean;
  heartbeat: boolean;
  last: bigint;
  target: bigint;
  validated: bigint;
}

export function createBoardEventStreams(
  getDatabase: () => Promise<Db>, installationId: string, gate: CommandGate, cursors: BoardEventCursors,
  { now = () => new Date(), heartbeatMs = boardHeartbeatMs } = {},
) {
  const subscribers = new Set<Subscriber>();
  let stopped = false;

  async function authorize(database: Db, token: string, boardId: string, binding?: BoardEventScope) {
    const access = await resolveBrowserWorkspace(database, installationId, token, now());
    if (binding && (access.actor.id !== binding.actorId || access.generationId !== binding.generationId)) {
      throw new WorkspaceAccessError('session');
    }
    await access.requireBoard(boardId);
    return access;
  }

  function close(subscriber: Subscriber, abort = true) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscribers.delete(subscriber);
    clearInterval(subscriber.timer);
    clearImmediate(subscriber.pending);
    subscriber.abort.removeEventListener('abort', subscriber.disconnect);
    // Transport failures are local to this subscriber, including failures from closing a socket.
    try { subscriber.transport.close(abort); } catch { /* Already closed. */ }
  }

  function send(subscriber: Subscriber, write: () => boolean) {
    if (subscriber.closed || subscriber.abort.aborted || !gate.ready) {
      close(subscriber);
      return false;
    }
    try {
      if (write()) return true;
    } catch { /* Drop a failed or backpressured transport. */ }
    close(subscriber);
    return false;
  }

  function reset(subscriber: Subscriber) {
    if (send(subscriber, () => subscriber.transport.frame({ event: 'reset', data: { boardId: subscriber.scope.boardId } }))) {
      close(subscriber, false);
    }
  }

  function schedule(subscriber: Subscriber) {
    if (subscriber.closed || subscriber.running || subscriber.pending) return;
    subscriber.pending = setImmediate(() => {
      subscriber.pending = undefined;
      void pump(subscriber);
    });
    subscriber.pending.unref();
  }

  async function pump(subscriber: Subscriber) {
    subscriber.running = true;
    try {
      const database = await getDatabase();
      const { scope } = subscriber;
      const store = createBoardEventStore(database, scope.generationId, scope.boardId);
      let sentHeartbeat = false;
      while (!subscriber.closed && (subscriber.heartbeat || subscriber.last < subscriber.target)) {
        await gate.readSnapshot(async () => {
          if (subscriber.closed) return;
          const heartbeat = subscriber.heartbeat && (!sentHeartbeat || subscriber.last === subscriber.target);
          if (heartbeat) subscriber.heartbeat = false;
          const access = await authorize(database, subscriber.token, scope.boardId, scope);
          sentHeartbeat = heartbeat;
          if (heartbeat) {
            send(subscriber, () => subscriber.transport.heartbeat());
            return;
          }
          if (subscriber.last === subscriber.target) return;
          if (subscriber.last >= subscriber.validated) {
            const target = subscriber.target;
            if (!(await store.contiguous(subscriber.last, target))) return reset(subscriber);
            subscriber.validated = target;
          }
          const next = subscriber.last + 1n;
          const event = await store.get(next);
          if (!event) return reset(subscriber);
          const frame = await projectBoardEvent(access, scope.boardId, event);
          if (send(subscriber, () => subscriber.transport.frame(frame, cursors.encode(scope, next)))) subscriber.last = next;
        });
      }
    } catch {
      close(subscriber);
    } finally { subscriber.running = false; }
  }

  // The caller holds the writer through reauthorization so a queued regrant cannot hide a revocation.
  async function revalidate(database: Db, applies: (scope: BoardEventScope) => boolean) {
    await Promise.all([...subscribers].filter(({ scope }) => applies(scope)).map(async (subscriber) => {
      try { await authorize(database, subscriber.token, subscriber.scope.boardId, subscriber.scope); }
      catch { close(subscriber); }
    }));
  }

  return {
    async subscribe(token: string, boardId: string, after: unknown, transport: BoardStreamTransport, abort: AbortSignal) {
      if (stopped || abort.aborted) throw new BoardStreamUnavailable();
      const database = await getDatabase();
      await gate.readSnapshot(async () => {
        if (stopped || abort.aborted) throw new BoardStreamUnavailable();
        const access = await authorize(database, token, boardId);
        const scope = { actorId: access.actor.id, generationId: access.generationId, boardId };
        const actorStreams = [...subscribers].filter((stream) => stream.scope.actorId === scope.actorId).length;
        if (subscribers.size >= maximumStreams || actorStreams >= maximumActorStreams) throw new BoardStreamLimit();

        const store = createBoardEventStore(database, scope.generationId, boardId);
        const high = await store.highWater();
        const start = after === undefined ? high : cursors.decode(scope, after);
        const valid = start !== null && await store.contiguous(start, high);
        if (!gate.ready || stopped || abort.aborted) throw new BoardStreamUnavailable();
        const subscriber: Subscriber = {
          scope, token, transport, abort, disconnect: () => close(subscriber), running: false, closed: false,
          heartbeat: false, last: start ?? high, target: high, validated: high,
        };
        // Register synchronously before leaving the same snapshot used for the high water and initial replay.
        subscribers.add(subscriber);
        abort.addEventListener('abort', subscriber.disconnect, { once: true });
        if (!send(subscriber, () => { transport.begin(); return true; })) return;
        if (!valid) return reset(subscriber);
        subscriber.timer = setInterval(() => {
          subscriber.heartbeat = true;
          schedule(subscriber);
        }, heartbeatMs);
        subscriber.timer.unref();
        if (subscriber.last < subscriber.target) schedule(subscriber);
      });
    },

    accept(signal: OutboxSignal) {
      const parsed = signedInt64TextSchema.safeParse(signal.sequence);
      if (!parsed.success) return;
      const sequence = BigInt(parsed.data);
      for (const subscriber of subscribers) {
        if (subscriber.scope.generationId !== signal.generationId || subscriber.scope.boardId !== signal.boardId
          || sequence <= subscriber.target) continue;
        subscriber.target = sequence;
        schedule(subscriber);
      }
    },

    disconnectToken(token: string) {
      for (const subscriber of subscribers) {
        if (subscriber.token === token) close(subscriber);
      }
    },

    revalidateActor(database: Db, actorId: string) {
      return revalidate(database, (scope) => scope.actorId === actorId);
    },

    revalidateBoards(database: Db, generationId: string, boards: ReadonlySet<string>) {
      return revalidate(database, (scope) => scope.generationId === generationId && boards.has(scope.boardId));
    },

    disconnectAll() {
      for (const subscriber of subscribers) close(subscriber);
    },

    stop() {
      stopped = true;
      for (const subscriber of subscribers) close(subscriber);
    },
  };
}

export type BoardEventStreams = ReturnType<typeof createBoardEventStreams>;
