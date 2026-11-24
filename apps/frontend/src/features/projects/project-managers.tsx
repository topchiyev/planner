import { useEffect, useState, type FormEvent } from 'react';
import { useRevalidator } from 'react-router';
import type { RelationshipReadOutput } from '@planner/contracts';
import type { loadNativeProject } from '../workspace/workspace-loaders.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import { ProjectDialog, useProjectAction } from './project-controls.js';
import { projectCommand, readProjectAffiliation } from './project-api.js';

type Project = NonNullable<Awaited<ReturnType<typeof loadNativeProject>>>;
type ManagerPage = RelationshipReadOutput<'projects.managers'>;
type CandidatePage = RelationshipReadOutput<'projects.managerCandidates'>;

export function ProjectManagersDialog({ project, close }: { project: Project; close: () => void }) {
  const { id, revision } = project;
  const [managerCursor, setManagerCursor] = useState<string | null>(null);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify([id, revision, query, managerCursor, candidateCursor, retry]);
  const [result, setResult] = useState<{ scope: string; managers?: ManagerPage; candidates?: CandidatePage }>();
  const action = useProjectAction();
  const revalidator = useRevalidator();
  useEffect(() => {
    const controller = new AbortController();
    const managers = new URLSearchParams();
    const candidates = new URLSearchParams({ q: query });
    if (managerCursor) managers.set('cursor', managerCursor);
    if (candidateCursor) candidates.set('cursor', candidateCursor);
    void Promise.all([
      readProjectAffiliation('projects.managers', id, managers, controller.signal),
      readProjectAffiliation('projects.managerCandidates', id, candidates, controller.signal),
    ]).then(([roster, eligible]) => {
      if (!controller.signal.aborted) setResult({ scope, managers: roster, candidates: eligible });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) {
        window.location.replace('/sign-in');
      } else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) {
        close();
        void revalidator.revalidate();
      } else setResult({ scope });
    });
    return () => controller.abort();
  }, [scope, id, query, managerCursor, candidateCursor]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setQuery(String(values.get('query') ?? '').trim());
    setCandidateCursor(null);
  }
  function resetPages() {
    setManagerCursor(null);
    setCandidateCursor(null);
    setResult(undefined);
    setRetry((value) => value + 1);
  }
  function add(userId: string) {
    void action.run(['manager-add', id, revision, userId], (csrf, key) =>
      projectCommand('projects.addManager', csrf, key, { id, revision, body: { userId } }), resetPages);
  }
  function remove(userId: string, edgeRevision: number | null) {
    void action.run(['manager-remove', id, userId, edgeRevision], (csrf, key) =>
      projectCommand('projects.removeManager', csrf, key, { id, userId, revision: edgeRevision }), () => {
      resetPages();
      if (userId === action.actorId) close();
    });
  }
  const active = result?.scope === scope && revalidator.state === 'idle' ? result : null;
  return <ProjectDialog title="Project managers" onClose={close} busy={action.busy}>
    {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
    <form className="project-form" role="search" onSubmit={search}>
      <label>Find an eligible manager<input type="search" name="query" maxLength={120} /></label>
      <button type="submit" className="workspace-button" disabled={action.busy}>Search accounts</button>
    </form>
    {!active ? <p role="status">Loading managers…</p> : !active.managers || !active.candidates ? <p role="alert">
      Manager information couldn’t load. <button type="button" className="workspace-button" onClick={() => {
        resetPages();
      }}>Retry</button>
    </p> : <>
      <section className="project-settings-section" aria-label="Current managers">
        <h3>Current managers</h3>
        <ul className="project-manager-list">{active.managers.data.map(({ id: edgeId, userId, person, revision: edgeRevision }) => <li key={edgeId}>
          <span>{person?.name ?? 'Unavailable account'}</span>
          <button type="button" className="workspace-button" disabled={action.busy}
            aria-label={`Remove ${person?.name ?? 'unavailable account'}`} onClick={() => remove(userId, edgeRevision)}>Remove</button>
        </li>)}</ul>
        <ManagerPages current={managerCursor} next={active.managers.page.nextCursor} label="managers" onPage={setManagerCursor} />
      </section>
      <section className="project-settings-section" aria-label="Eligible accounts">
        <h3>Eligible accounts</h3>
        {active.candidates.data.length ? <ul className="project-manager-list">{active.candidates.data.map((person) => <li key={person.id}>
          <span>{person.name}{person.username && <small>{person.username}</small>}</span>
          <button type="button" className="workspace-button" disabled={action.busy} aria-label={`Add ${person.name}`}
            onClick={() => add(person.id)}>Add</button>
        </li>)}</ul> : <p>No eligible accounts found.</p>}
        <ManagerPages current={candidateCursor} next={active.candidates.page.nextCursor} label="eligible accounts" onPage={setCandidateCursor} />
      </section>
    </>}
  </ProjectDialog>;
}

function ManagerPages({ current, next, label, onPage }: { current: string | null; next: string | null; label: string; onPage: (value: string | null) => void }) {
  if (!current && !next) return null;
  return <nav className="project-actions" aria-label={`Pages of ${label}`}>
    {current && <button type="button" className="workspace-button" onClick={() => onPage(null)}>First page</button>}
    {next && <button type="button" className="workspace-button" onClick={() => onPage(next)}>Next page</button>}
  </nav>;
}
