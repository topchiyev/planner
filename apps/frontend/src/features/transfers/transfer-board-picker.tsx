import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { workspaceSignInPath, type RelationshipReadOutput, type WorkspaceReadOutput } from '@planner/contracts';
import { readAffiliation } from '../projects/project-api.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';

type DestinationPage = RelationshipReadOutput<'boards.transferDestinations'>;
type BoardWorkspace = WorkspaceReadOutput<'boardWorkspace'>['data'];
export type TransferBoard = { id: string; lists: BoardWorkspace['lists']; orderVersion: number };

export function TransferBoardPicker({ sourceBoardId, onPick, onUnavailable }: {
  sourceBoardId: string; onPick: (destination: TransferBoard | null | undefined) => void; onUnavailable: () => void;
}) {
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [rows, setRows] = useState<DestinationPage['data']>([]);
  const [next, setNext] = useState<string>();
  const [selected, setSelected] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const callbacks = useRef({ onPick, onUnavailable });
  callbacks.current = { onPick, onUnavailable };

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: filter });
    if (cursor) params.set('cursor', cursor);
    void readAffiliation('boards.transferDestinations', sourceBoardId, params, controller.signal).then(({ data, page }) => {
      if (controller.signal.aborted) return;
      setRows((current) => cursor ? [...new Map([...current, ...data].map((row) => [row.id, row])).values()] : data);
      setNext(page.nextCursor ?? undefined);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(signIn);
      else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) callbacks.current.onUnavailable();
      else setProblem('Destination boards couldn’t load.');
    });
    return () => controller.abort();
  }, [open, sourceBoardId, filter, cursor, searchAttempt, signIn]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void readWorkspace('boardWorkspace', selected, undefined, controller.signal).then(({ data }) => {
      if (controller.signal.aborted) return;
      if (!data.board.permissions.canEdit) throw new WorkspaceRequestError(403, 'FORBIDDEN');
      callbacks.current.onPick({ id: selected, lists: data.lists, orderVersion: data.orderVersion });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(signIn);
      else {
        setSelected('');
        callbacks.current.onPick(null);
        setProblem('That destination is unavailable.');
      }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [selected, signIn]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setProblem('');
    setRows([]);
    setNext(undefined);
    setSelected('');
    setBusy(false);
    callbacks.current.onPick(null);
    setSearchAttempt((count) => count + 1);
    setFilter(draft.trim());
    setCursor(undefined);
  }
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="workspace-button">Choose another board</summary>
    {open && <div className="project-form">
      <label>Find destination board<input type="search" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={120}
        onKeyDown={(event) => { if (event.key === 'Enter') applySearch(event); }} /></label>
      <button type="button" className="workspace-button" onClick={applySearch}>Search boards</button>
      <label>Destination board<select value={selected} onChange={(event) => {
        const id = event.target.value;
        setProblem('');
        setSelected(id);
        setBusy(!!id);
        callbacks.current.onPick(id ? undefined : null);
      }}>
        <option value="">Current board</option>
        {rows.map(({ id, name, project }) => <option key={id} value={id}>{project.name} · {name}</option>)}
      </select></label>
      {busy && <p role="status">Loading board lists…</p>}
      {next && <button type="button" className="workspace-button" onClick={() => setCursor(next)}>More boards</button>}
      {problem && <p role="alert" className="workspace-problem">{problem}</p>}
    </div>}
  </details>;
}
