import { useEffect, useState } from 'react';
import { Link, useLocation, useRevalidator } from 'react-router';
import { workspaceSignInPath, type WorkspaceReadOutput } from '@planner/contracts';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import './discussions.css';

type Feed = 'cardComments' | 'cardActivity' | 'boardActivity';
type FeedCard = WorkspaceReadOutput<'boardActivity'>['data'][number]['card'];

export function feedCardHref(card: FeedCard) {
  return `/boards/${card.boardId}/cards/${card.id}` + (card.kind === 'board' ? '' : '?context=' + card.kind);
}

export function useScopedFeed<K extends Feed>(operation: K, id: string, version: number | string, boardId?: string, enabled = true) {
  const { pathname, search } = useLocation();
  const revalidator = useRevalidator();
  const [cursor, setCursor] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const binding = JSON.stringify([operation, id, version, boardId, cursor, attempt]);
  const [result, setResult] = useState<{ binding: string; data?: WorkspaceReadOutput<K> }>();
  useEffect(() => {
    if (!enabled || revalidator.state !== 'idle') return;
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: '20' });
    if (boardId) query.set('boardId', boardId);
    if (cursor) query.set('cursor', cursor);
    void readWorkspace(operation, id, query, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setResult({ binding, data }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(workspaceSignInPath(pathname + search));
        else if (error instanceof WorkspaceRequestError && error.code === 'INVALID_CURSOR' && cursor) setCursor(undefined);
        else setResult({ binding });
      });
    return () => controller.abort();
  }, [enabled, operation, id, boardId, cursor, binding, pathname, search, revalidator.state]);
  return {
    result: result?.binding === binding ? result : null,
    cursor, setCursor,
    retry() { setCursor(undefined); setAttempt((next) => next + 1); },
  };
}

export function FeedPagination({ cursor, next, select }: { cursor?: string; next?: string | null; select: (cursor?: string) => void }) {
  if (!cursor && !next) return null;
  return <nav className="project-actions" aria-label="Feed pages">
    {cursor && <button className="workspace-button" type="button" onClick={() => select()}>First page</button>}
    {next && <button className="workspace-button" type="button" onClick={() => select(next)}>Older entries</button>}
  </nav>;
}

export function FeedTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))}</time>;
}

const activityTitles = {
  createCard: 'created this card', moveCard: 'moved this card', assignCard: 'assigned a member',
  unassignCard: 'unassigned a member', completeTask: 'completed a task', uncompleteTask: 'reopened a task',
};

export function ActivityFeed({ id, revision, boardId, removed }: {
  id: string; revision: number | string; boardId?: string; removed?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const { result, cursor, setCursor, retry } = useScopedFeed(boardId ? 'cardActivity' : 'boardActivity', id, revision, boardId, open);
  const data = result?.data;
  const entries = data?.data.filter((entry) => !removed?.has(entry.card.id)) ?? [];
  return <details className="workspace-feed activity-feed" aria-label={boardId ? 'Card activity' : 'Board activity'}
    open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{boardId ? 'Card activity' : 'Board activity'}</summary>
    {open && (!result ? <p role="status">Loading activity…</p> : !data
      ? <p role="alert">Activity couldn’t load. <button className="workspace-button" type="button" onClick={retry}>Retry</button></p>
      : <>
        {entries.length === 0 && <p>No activity.</p>}
        <ol className="feed-entries">
          {entries.map((event) => <li key={event.id}>
            <p><strong>{event.actor?.name ?? 'Unknown account'}</strong> {activityTitles[event.kind]}.</p>
            {!boardId && <Link to={feedCardHref(event.card)}>{event.card.name}</Link>}
            <FeedTime value={event.createdAt} />
          </li>)}
        </ol>
        <FeedPagination cursor={cursor} next={data.page.nextCursor} select={setCursor} />
      </>)}
  </details>;
}
