import { useEffect, useState } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import { workspaceSignInPath, type RelationshipReadOutput } from '@planner/contracts';
import { readAffiliation } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';

type CandidatePage = RelationshipReadOutput<'boards.mentionMembers'>;

export function useEligibleMemberPage(boardId: string, revision: number) {
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const revalidator = useRevalidator();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [accessLost, setAccessLost] = useState(false);
  const scope = JSON.stringify([boardId, revision, query, cursor, retry]);
  const [result, setResult] = useState<{ scope: string; page?: CandidatePage }>();
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({ q: query });
    if (cursor) params.set('cursor', cursor);
    void readAffiliation('boards.mentionMembers', boardId, params, abort.signal).then((page) => {
      if (!abort.signal.aborted) setResult({ scope, page });
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(signIn);
      else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) setAccessLost(true);
      else setResult({ scope });
    });
    return () => abort.abort();
  }, [boardId, query, cursor, scope, signIn]);

  return {
    result: result?.scope === scope && revalidator.state === 'idle' ? result : null,
    accessLost, cursor, setCursor,
    search(value: string) { setQuery(value.trim()); setCursor(undefined); },
    retry() { setCursor(undefined); setRetry((value) => value + 1); },
  };
}
