import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import { workspaceSignInPath, type RelationshipReadOutput } from '@planner/contracts';
import { readAffiliation, relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import { useBoardMutation } from './board-actions.js';
import type { BoardWorkspace } from './board-management.js';

type MemberPage = RelationshipReadOutput<'boards.members'>;
type CandidatePage = RelationshipReadOutput<'boards.memberCandidates'>;
type MemberRole = 'editor' | 'viewer';

export function BoardMembersDialog({ board, close }: { board: BoardWorkspace['board']; close: () => void }) {
  const action = useBoardMutation();
  const revalidator = useRevalidator();
  const location = useLocation();
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify([board.id, board.revision, query, memberCursor, candidateCursor, retry]);
  const [result, setResult] = useState<{ scope: string; memberPage?: MemberPage; candidatePage?: CandidatePage }>();
  useEffect(() => {
    const controller = new AbortController();
    const members = new URLSearchParams();
    const candidates = new URLSearchParams({ q: query });
    if (memberCursor) members.set('cursor', memberCursor);
    if (candidateCursor) candidates.set('cursor', candidateCursor);
    void Promise.all([
      readAffiliation('boards.members', board.id, members, controller.signal),
      readAffiliation('boards.memberCandidates', board.id, candidates, controller.signal),
    ]).then(([memberPage, candidatePage]) => {
      if (!controller.signal.aborted) setResult({ scope, memberPage, candidatePage });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) {
        window.location.replace(workspaceSignInPath(location.pathname + location.search));
      } else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) {
        close();
        void revalidator.revalidate();
      } else setResult({ scope });
    });
    return () => controller.abort();
  }, [scope, board.id, query, memberCursor, candidateCursor, location.pathname, location.search]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim());
    setCandidateCursor(null);
  }
  function reset() {
    setMemberCursor(null);
    setCandidateCursor(null);
    setRetry((value) => value + 1);
  }
  function add(userId: string, role: MemberRole, canComment: boolean | null) {
    const body = { userId, role, canComment };
    void action.run(['boards.addMember', board.id, board.revision, body], (csrf, key) =>
      relationshipCommand('boards.addMember', csrf, key, { id: board.id, revision: board.revision, body }), reset);
  }
  function edit(userId: string, revision: number | null, role: MemberRole, canComment: boolean | null) {
    const body = { role, canComment };
    void action.run(['boards.updateMember', board.id, userId, revision, body], (csrf, key) =>
      relationshipCommand('boards.updateMember', csrf, key, { id: board.id, userId, revision, body }), reset);
  }
  function remove(userId: string, revision: number | null) {
    void action.run(['boards.removeMember', board.id, userId, revision], (csrf, key) =>
      relationshipCommand('boards.removeMember', csrf, key, { id: board.id, userId, revision }), reset);
  }

  const active = result?.scope === scope && revalidator.state === 'idle' ? result : null;
  return <WorkspaceDialog title="Board members" onClose={close} busy={action.busy}>
    {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
    <form role="search" className="project-form" onSubmit={search}>
      <label>Find an eligible account<input type="search" name="q" maxLength={120} /></label>
      <button type="submit" className="workspace-button" disabled={action.busy}>Search accounts</button>
    </form>
    {!active ? <p role="status">Loading board members…</p> : !active.memberPage || !active.candidatePage ?
      <p role="alert">Board membership couldn’t load. <button className="workspace-button" onClick={reset} type="button">Retry</button></p> : <>
      <section className="project-settings-section" aria-label="Current board members">
        <h3>Current members</h3>
        {active.memberPage.data.length ? <ul className="project-manager-list">
          {active.memberPage.data.map(({ id, userId, person, revision, role, canComment }) => <li key={id}>
            <span>{person?.name ?? 'Unavailable account'}{person?.username && <small>{person.username}</small>}</span>
            <MemberEditor label={person?.name ?? 'Unavailable account'} role={role} canComment={canComment} busy={action.busy}
              onSubmit={(next, comment) => edit(userId, revision, next, comment)} />
            {action.actorId !== userId && <button type="button" className="workspace-button" disabled={action.busy}
              aria-label={`Remove ${person?.name ?? 'unavailable account'}`} onClick={() => remove(userId, revision)}>Remove</button>}
          </li>)}
        </ul> : <p>No direct members.</p>}
        <MemberPages current={memberCursor} next={active.memberPage.page.nextCursor} label="members" onPage={setMemberCursor} />
      </section>
      <section className="project-settings-section" aria-label="Eligible board accounts">
        <h3>Eligible accounts</h3>
        {active.candidatePage.data.length ? <ul className="project-manager-list">{active.candidatePage.data.map((person) => <li key={person.id}>
          <span>{person.name}{person.username && <small>{person.username}</small>}</span>
          <MemberEditor label={person.name} busy={action.busy} onSubmit={(role, comment) => add(person.id, role, comment)} />
        </li>)}</ul> : <p>No eligible accounts found.</p>}
        <MemberPages current={candidateCursor} next={active.candidatePage.page.nextCursor} label="eligible accounts" onPage={setCandidateCursor} />
      </section>
    </>}
  </WorkspaceDialog>;
}

function MemberEditor({ label, role, canComment, busy, onSubmit }: {
  label: string; role?: MemberRole; canComment?: boolean | null; busy: boolean;
  onSubmit: (role: MemberRole, canComment: boolean | null) => void;
}) {
  const [next, setNext] = useState<MemberRole>(role ?? 'viewer');
  const [comment, setComment] = useState(canComment === true);
  const permission = next === 'editor' ? null : comment;
  const verb = role ? 'Update' : 'Add';
  return <form className="board-membership-controls" onSubmit={(event) => { event.preventDefault(); onSubmit(next, permission); }}>
    <label className="board-membership-label">Role
      <select aria-label={`Role for ${label}`} value={next} onChange={(event) => setNext(event.target.value as MemberRole)}>
        <option value="viewer">Viewer</option><option value="editor">Editor</option>
      </select>
    </label>
    {next === 'viewer' && <label className="board-checkbox">
      <input type="checkbox" aria-label={`Allow comments for ${label}`} checked={comment} onChange={(event) => setComment(event.target.checked)} />
      Allow comments
    </label>}
    <button type="submit" className="workspace-button" aria-label={`${verb} ${label}`}
      disabled={busy || (role === next && permission === canComment)}>{verb}</button>
  </form>;
}

function MemberPages({ current, next, label, onPage }: { current: string | null; next: string | null; label: string; onPage: (value: string | null) => void }) {
  if (!current && !next) return null;
  return <nav className="project-actions" aria-label={`Pages of ${label}`}>
    {current && <button type="button" className="workspace-button" onClick={() => onPage(null)}>First page</button>}
    {next && <button type="button" className="workspace-button" onClick={() => onPage(next)}>Next page</button>}
  </nav>;
}
