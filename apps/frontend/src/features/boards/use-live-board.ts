import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { boardEventsPath, boardEventCursorSchema, boardEventFrameSchema, workspaceSignInPath } from '@planner/contracts';
import { readBrowserSession } from '../auth/browser-session.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import { readNativeBoard, readNativeCard } from '../workspace/workspace-loaders.js';

export type LiveBoard = NonNullable<Awaited<ReturnType<typeof readNativeBoard>>>;
export type LiveCard = Awaited<ReturnType<typeof readNativeCard>>;

const events = boardEventFrameSchema.options.map((schema) => schema.shape.event.value);
const retryDelays = [500, 1000, 2000, 4000, 8000] as const;

type Result = {
  source: LiveBoard;
  board: LiveBoard;
  card: LiveCard | undefined;
};

type State = {
  scope: symbol;
  phase: 'visible' | 'checking' | 'unavailable' | 'missing';
  removed: ReadonlySet<string>;
  result?: Result;
};

export function useLiveBoard({ initial, actorId, cardId, location }: {
  initial: LiveBoard | null | undefined;
  actorId?: string;
  cardId?: string;
  location: string;
}) {
  const boardId = initial?.board.id;
  const recipeScope = initial?.recipeScope;
  const scope = useMemo(() => Symbol(), [actorId, recipeScope, boardId, location]);
  const current = useRef(initial);
  useLayoutEffect(() => { current.current = initial; }, [initial]);
  const [stored, setStored] = useState<State>();
  const manual = useRef<() => void>(() => {});
  const state = stored?.scope === scope ? stored : undefined;
  const removed = state?.removed;
  const snapshot = state?.result;
  const result = snapshot && initial && (snapshot.source === initial ||
    BigInt(snapshot.board.latestEventSequence) > BigInt(initial.latestEventSequence)) ? snapshot : undefined;

  useEffect(() => {
    const first = current.current;
    if (!boardId || !recipeScope || !actorId || !first) return;
    const eventsPath = boardEventsPath.replace(':id', boardId);
    let active = true;
    let source: EventSource | undefined;
    let refresh: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queued = false;
    let nextRefreshAt = 0;
    let retry = 0;
    let reconnect = false;
    let connectedAt = 0;
    let invalidation = 0;
    let phase: State['phase'] = 'visible';
    let result: Result | undefined;
    const removed = new Set<string>();

    function publish() {
      if (active) setStored({ scope, phase, result, removed: new Set(removed) });
    }

    function close() {
      source?.close();
      source = undefined;
    }

    function stop(next: State['phase']) {
      invalidation += 1;
      refresh?.abort();
      close();
      queued = false;
      clearTimeout(timer);
      timer = undefined;
      phase = next;
      publish();
    }

    function schedule(delay = 60) {
      if (!queued) nextRefreshAt = Date.now() + delay;
      queued = true;
      if (!active || timer || refresh) return;
      timer = setTimeout(() => {
        timer = undefined;
        void revalidate();
      }, Math.max(0, nextRefreshAt - Date.now()));
    }

    function checkAgain(delay = 0) {
      invalidation += 1;
      phase = 'checking';
      publish();
      clearTimeout(timer);
      timer = undefined;
      queued = false;
      refresh?.abort();
      schedule(delay);
    }

    function recover(delay: number) {
      close();
      reconnect = true;
      checkAgain(delay);
    }

    function connectionLost(reset = false) {
      if (connectedAt && Date.now() - connectedAt >= 20_000) retry = 0;
      const delay = retryDelays[retry++];
      if (delay === undefined) stop('unavailable');
      else recover(reset && retry === 1 ? 0 : delay);
    }

    function connect(cursor: string) {
      close();
      const connection = new EventSource(eventsPath + '?' + new URLSearchParams({ after: cursor }));
      source = connection;
      connectedAt = 0;
      connection.onopen = () => {
        if (source !== connection) return;
        connectedAt = Date.now();
        // The stream and every subsequently displayed snapshot overlap, including the selected card.
        schedule();
      };
      connection.onerror = () => {
        if (source === connection) connectionLost();
      };
      let latest = cursor;
      for (const event of events) connection.addEventListener(event, (message: MessageEvent<string>) => {
        if (source !== connection) return;
        let data: unknown;
        try { data = JSON.parse(message.data); }
        catch { connectionLost(); return; }
        const frame = boardEventFrameSchema.safeParse({ event, data });
        if (!frame.success || frame.data.data.boardId !== boardId ||
          (event !== 'reset' && !boardEventCursorSchema.safeParse(message.lastEventId).success)) {
          connectionLost();
          return;
        }
        if (frame.data.event === 'reset') { connectionLost(true); return; }
        if (frame.data.event === 'ready' || message.lastEventId === latest) return;
        latest = message.lastEventId;
        if (frame.data.event === 'card.removed') {
          invalidation += 1;
          removed.add(frame.data.data.id);
          publish();
        }
        if (frame.data.event === 'board.access-changed') checkAgain();
        else schedule();
      });
    }

    async function revalidate() {
      const baseline = current.current;
      if (!active || !queued || !baseline || !boardId) return;
      queued = false;
      const controller = new AbortController();
      refresh = controller;
      const { signal } = controller;
      const url = new URL(location, window.location.origin);
      const ticket = invalidation;
      const deadline = setTimeout(() => controller.abort(), 12_000);
      function superseded() {
        if (active && baseline !== current.current) schedule();
        return !active || ticket !== invalidation || baseline !== current.current;
      }
      try {
        const session = await readBrowserSession(signal, 'passive');
        if (superseded()) return;
        if (session?.account.id !== actorId) {
          stop('checking');
          window.location.replace(workspaceSignInPath(location));
          return;
        }
        const board = await readNativeBoard(boardId, url, signal, true);
        if (superseded()) return;
        if (board === null || board.recipeScope !== recipeScope) { stop('missing'); return; }
        const card = cardId ? await readNativeCard(boardId, cardId, signal) : undefined;
        if (superseded()) return;
        result = { source: baseline, board, card };
        removed.clear();
        phase = 'visible';
        publish();
        if (reconnect) {
          reconnect = false;
          connect(board.eventCursor);
        }
      } catch (error) {
        if (superseded()) return;
        if (error instanceof WorkspaceRequestError) {
          if (error.status === 401) {
            stop('checking');
            window.location.replace(workspaceSignInPath(location));
            return;
          }
          if (error.status === 403 || error.status === 404) { stop('missing'); return; }
        }
        const delay = retryDelays[retry++];
        if (delay === undefined) stop('unavailable');
        else {
          close();
          reconnect = true;
          phase = 'checking';
          publish();
          queued = false;
          schedule(delay);
        }
      } finally {
        clearTimeout(deadline);
        refresh = undefined;
        if (queued) schedule();
      }
    }

    manual.current = () => {
      retry = 0;
      recover(0);
    };
    connect(first.eventCursor);
    return () => {
      active = false;
      close();
      clearTimeout(timer);
      refresh?.abort();
      manual.current = () => {};
    };
  }, [scope, boardId, actorId, recipeScope, cardId, location]);

  const recheck = useCallback(() => manual.current(), []);
  return {
    board: result?.board ?? initial,
    card: cardId && removed?.has(cardId) ? null : result?.card,
    removed,
    phase: state?.phase ?? 'visible',
    recheck,
  };
}
