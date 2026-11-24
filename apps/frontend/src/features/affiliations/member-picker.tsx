import { useBoardRefresh } from '../boards/board-refresh.js';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { workspaceSignInPath, type RelationshipReadOutput } from '@planner/contracts';
import { readAffiliation } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';

export type Mention = RelationshipReadOutput<'boards.mentionMembers'>['data'][number];

export function MemberPicker({ boardId, select, label = 'Mention a board member' }: {
  boardId: string; select: (person: Mention) => void; label?: string;
}) {
  const { pathname, search } = useLocation();
  const refresh = useBoardRefresh();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const binding = JSON.stringify([boardId, query, cursor, attempt]);
  const [selected, setSelected] = useState<{ binding: string; page?: RelationshipReadOutput<'boards.mentionMembers'> }>();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query, limit: '10' });
    if (cursor) params.set('cursor', cursor);
    void readAffiliation('boards.mentionMembers', boardId, params, controller.signal)
      .then((page) => { if (!controller.signal.aborted) setSelected({ binding, page }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof WorkspaceRequestError && error.status === 401) {
          window.location.replace(workspaceSignInPath(pathname + search));
        } else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) {
          setOpen(false);
          refresh();
        } else setSelected({ binding });
      });
    return () => controller.abort();
  }, [open, boardId, query, cursor, binding, pathname, search]);

  function submit() {
    setQuery(draft.trim());
    setCursor(null);
    setAttempt((value) => value + 1);
  }

  const result = selected?.binding === binding ? selected : undefined;
  const next = result?.page?.page.nextCursor;
  return <div className="card-mention-picker">
    <button className="workspace-button" type="button" aria-expanded={open} onClick={() => {
      if (!open) { setCursor(null); setAttempt((value) => value + 1); }
      setOpen(!open);
    }}>{label}</button>
    {open && <div>
      <label>Find a board member<input type="search" value={draft} maxLength={120} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} /></label>
      <button type="button" className="workspace-button" onClick={submit}>Find members</button>
      {!result ? <p role="status">Loading board members…</p> : !result.page ? <p>Board members couldn’t load.</p> :
        !result.page.data.length ? <p>No matching board members.</p> : <ul>
          {result.page.data.map((person) => <li key={person.id}>
            <button type="button" className="workspace-button" aria-label={'Mention ' + person.name}
              onClick={() => { select(person); setOpen(false); }}>{person.name}{person.username ? ' · @' + person.username : ''}</button>
          </li>)}
        </ul>}
      {(cursor || next) && <nav aria-label="Mention results pages" className="project-actions">
        {cursor && <button type="button" className="workspace-button" onClick={() => setCursor(null)}>First members page</button>}
        {next && <button type="button" className="workspace-button" onClick={() => setCursor(next)}>Next members page</button>}
      </nav>}
    </div>}
  </div>;
}
