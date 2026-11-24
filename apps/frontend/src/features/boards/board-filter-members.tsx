import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { workspaceSignInPath, type RelationshipReadOutput } from '@planner/contracts';
import { readAffiliation } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';

type Page = RelationshipReadOutput<'boards.filterMembers'>;

export function BoardFilterMembers({ boardId, revision, children, onAccessLost }: {
  boardId: string; revision: number; onAccessLost: () => void;
  children: (person: Page['data'][number]) => React.ReactNode;
}) {
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const onUnavailable = useRef(onAccessLost);
  onUnavailable.current = onAccessLost;
  const [result, setResult] = useState<{ revision: number; people: Page['data']; next: string | null }>();
  const [cursor, setCursor] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(cursor ? { cursor } : {});
    void readAffiliation('boards.filterMembers', boardId, params, controller.signal).then(({ data, page }) => {
      if (controller.signal.aborted) return;
      setProblem(false);
      setResult((previous) => ({
        revision, next: page.nextCursor, people: cursor && previous?.revision === revision
          ? [...new Map([...previous.people, ...data].map((person) => [person.id, person])).values()] : data,
      }));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(signIn);
      else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) onUnavailable.current();
      else setProblem(true);
    });
    return () => controller.abort();
  }, [boardId, revision, cursor, retry, signIn]);

  const current = result?.revision === revision ? result : null;
  return <fieldset className="board-filter-group">
    <legend>Members</legend>
    {problem ? <p role="status">Members couldn’t load. <button className="workspace-button" type="button" onClick={() => {
      setCursor(undefined); setRetry((value) => value + 1);
    }}>Retry</button></p> : !current ? <p role="status">Loading members…</p> : <>
      {current.people.length ? current.people.map(children) : <p>No eligible members.</p>}
      {current.next && <button className="workspace-button" type="button" disabled={cursor === current.next}
        onClick={() => setCursor(current.next!)}>More members</button>}
    </>}
  </fieldset>;
}
