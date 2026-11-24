import { useEffect, useState } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import { workspaceSignInPath, type RelationshipReadOutput } from '@planner/contracts';
import { readAffiliation } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';

type Page = RelationshipReadOutput<'fields.templateOptions'>;

export function FieldTemplatePicker({ boardId, selected, select, onAccessLost }: {
  boardId: string; selected: string; select: (id: string) => void; onAccessLost: () => void;
}) {
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const revalidator = useRevalidator();
  const [cursor, setCursor] = useState<string>();
  const [result, setResult] = useState<{ cursor?: string; page: Page }>();
  const [templates, setTemplates] = useState<Page['data']>([]);
  const [problem, setProblem] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams(cursor ? { cursor } : {});
    void readAffiliation('fields.templateOptions', boardId, params, abort.signal).then((page) => {
      if (abort.signal.aborted) return;
      setResult({ cursor, page });
      setTemplates((previous) => [...previous, ...page.data.filter(({ id }) => !previous.some((row) => row.id === id))]);
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(signIn);
      else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) {
        onAccessLost();
        void revalidator.revalidate();
      } else setProblem(true);
    });
    return () => abort.abort();
  }, [boardId, cursor, retry, signIn]);

  const next = result?.cursor === cursor ? result?.page.page.nextCursor : undefined;
  return <>
    <label>Project template
      <select value={selected} onChange={(event) => select(event.target.value)}>
        <option value="">No template</option>
        {templates.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
    {problem ? <p role="status">Templates are unavailable. <button type="button" className="workspace-button" onClick={() => {
      setProblem(false); setRetry((value) => value + 1);
    }}>Retry</button></p> : result?.cursor !== cursor || !result ?
      <p role="status">Loading templates…</p> : next && <button type="button" className="workspace-button"
        onClick={() => setCursor(next)}>More templates</button>}
  </>;
}
