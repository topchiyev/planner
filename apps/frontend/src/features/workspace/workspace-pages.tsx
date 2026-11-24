import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLoaderData, useLocation, useNavigation, useRevalidator, useRouteLoaderData, useSearchParams } from 'react-router';
import { workspaceSignInPath } from '@planner/contracts';
import { EmptyState, PageHeading, RouteNotFound } from '../../app/page-state.js';
import { ProjectBackgroundPreview, ProjectSettingsControls } from '../projects/project-settings.js';
import type { loadBrowserSession } from '../auth/browser-session.js';
import {
  type BoardSummary, type DisplayPreferences, type ProjectSummary, readWorkspace, saveDisplayPreference, saveProjectFavorite, WorkspaceRequestError,
} from './workspace-api.js';
import { workspaceFilters, type loadNativeProject } from './workspace-loaders.js';
import { BoardLinks, projectHref, useWorkspaceNavigation } from './workspace-navigation.js';

function useWorkspaceAction() {
  const session = useRouteLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>('app-shell');
  const revalidator = useRevalidator();
  const { pathname, search } = useLocation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return {
    busy,
    problem,
    async run(save: (csrfToken: string) => Promise<void>, onRevision?: () => void) {
      if (!session || pending.current) return;
      pending.current = true;
      setBusy(true);
      setProblem('');
      try {
        await save(session.csrfToken);
        if (!mounted.current) return;
        if (onRevision) onRevision();
        else await revalidator.revalidate();
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof WorkspaceRequestError && error.status === 401) {
          window.location.replace(workspaceSignInPath(pathname + search));
        } else if (error instanceof WorkspaceRequestError && error.status === 409) {
          setProblem('This changed in another session. The current information has been loaded. Try again.');
          await revalidator.revalidate();
        } else if (error instanceof WorkspaceRequestError && error.status === 404) {
          await revalidator.revalidate();
        } else {
          setProblem('Planner could not save this change. Try again.');
        }
      } finally {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    },
  };
}

function FavoriteButton({ project, busy, onToggle }: {
  project: ProjectSummary; busy: boolean; onToggle: () => void;
}) {
  if (!project.permissions.canFavorite) return null;
  return <button aria-pressed={project.favorite} className="workspace-favorite" disabled={busy}
    aria-label={project.favorite ? `Remove ${project.name} from favorites` : `Add ${project.name} to favorites`}
    onClick={onToggle} type="button"><span aria-hidden="true">{project.favorite ? '★' : '☆'}</span></button>;
}

function LazyBoardLinks({ projectId, scope }: { projectId: string; scope: object }) {
  const [result, setResult] = useState<{ scope: object; boards?: BoardSummary[] }>();
  const [attempt, setAttempt] = useState(0);
  const location = useLocation();
  const currentLocation = useRef(location);
  currentLocation.current = location;
  useEffect(() => {
    const controller = new AbortController();
    void readWorkspace('boardsList', projectId, undefined, controller.signal).then(({ data }) => {
      if (!controller.signal.aborted) setResult({ scope, boards: data });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) {
        window.location.replace(workspaceSignInPath(currentLocation.current.pathname + currentLocation.current.search));
      } else setResult({ scope });
    });
    return () => controller.abort();
  }, [projectId, scope, attempt]);
  if (!result || result.scope !== scope) return <p className="workspace-inline-state" role="status">Loading boards…</p>;
  if (!result.boards) return <p className="workspace-inline-state" role="status">Boards couldn’t load.
    <button className="workspace-text-button" type="button" onClick={() => { setResult(undefined); setAttempt((value) => value + 1); }}>Retry</button>
  </p>;
  return result.boards.length ? <BoardLinks boards={result.boards} /> : <p className="workspace-inline-state">No boards to show</p>;
}

function ProjectTile({ project, grouped, open, onExpand, busy, onFavorite, scope }: {
  project: ProjectSummary; grouped: boolean; open: boolean; onExpand: () => void; busy: boolean; onFavorite: () => void; scope: object;
}) {
  const boardsId = useId();
  return <article className="workspace-project">
    <div className="workspace-project-main">
      {grouped && <button aria-controls={boardsId} aria-expanded={open} aria-label={`Boards in ${project.name}`}
        className="workspace-disclosure" onClick={onExpand} type="button">
        <span aria-hidden="true" className="workspace-chevron" />
      </button>}
      <div className="workspace-project-title">
        <h2><Link to={projectHref(project.id)}>{project.name}</Link></h2>
        <p>{project.boardCount} {project.boardCount === 1 ? 'board' : 'boards'}{project.hidden && <span className="workspace-hidden">Hidden</span>}</p>
      </div>
      <FavoriteButton project={project} busy={busy} onToggle={onFavorite} />
    </div>
    {grouped && <div className="workspace-project-boards" hidden={!open} id={boardsId}>
      {open && <LazyBoardLinks projectId={project.id} scope={scope} />}
    </div>}
  </article>;
}

export function NativeWorkspacePage() {
  const data = useWorkspaceNavigation();
  if (!data) return null;
  return <WorkspaceProjects data={data} />;
}

function WorkspaceProjects({ data }: { data: NonNullable<ReturnType<typeof useWorkspaceNavigation>> }) {
  const [query, setQuery] = useSearchParams();
  const { filters, preferences, projectsPage } = data;
  const { homeView, projectOrder, showFavorites } = preferences.preferences;
  const settings = useWorkspaceAction();
  const favorites = useWorkspaceAction();
  const navigation = useNavigation();
  const searchTarget = navigation.location?.pathname === '/workspace' ? navigation.location.search : null;
  const displayedFilters = searchTarget === null ? filters
    : workspaceFilters(new URL('/workspace' + searchTarget, window.location.origin));
  const [requested, setRequested] = useState<Partial<DisplayPreferences>>({});
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchInput.current) searchInput.current.value = filters.q; }, [filters.q]);
  const grouped = homeView === 'groupedProjects';

  function setFilter(field: string, value: string | null) {
    const next = new URLSearchParams(query);
    if (value) next.set(field, value);
    else next.delete(field);
    if (field !== 'open') {
      next.delete('cursor');
      next.delete('favoriteCursor');
    }
    setQuery(next);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    setFilter('q', typeof q === 'string' ? q.trim() : null);
  }

  function changeSetting<K extends keyof DisplayPreferences>(field: K, value: DisplayPreferences[K]) {
    if (preferences.preferences[field] === value) return;
    setRequested({ [field]: value });
    void settings.run(async (csrfToken) => {
      await saveDisplayPreference(field, value, preferences.revision, csrfToken);
    }, field === 'projectOrder' && (filters.cursor || filters.favoriteCursor)
      ? () => {
        const next = new URLSearchParams(window.location.search);
        next.delete('cursor');
        next.delete('favoriteCursor');
        setQuery(next, { replace: true });
      }
      : undefined).finally(() => setRequested({}));
  }

  function pageTarget(cursor: string | null) {
    const next = new URLSearchParams(query);
    if (cursor) next.set('cursor', cursor);
    else next.delete('cursor');
    next.delete('open');
    return { pathname: '/workspace', search: next.toString() };
  }

  return (
    <section className="page workspace-page" aria-labelledby="page-heading">
      <header className="page-header"><PageHeading id="page-heading">Projects</PageHeading></header>
      <div className="workspace-toolbar">
        <form className="workspace-search" onSubmit={search} role="search">
          <label>Search projects<input ref={searchInput} type="search" defaultValue={filters.q} maxLength={256} name="q" /></label>
          <button type="submit">Search</button>
        </form>
        <label>Visibility<select value={displayedFilters.hidden} onChange={(event) => setFilter('hidden', event.target.value === 'exclude' ? null : event.target.value)}>
          <option value="exclude">Visible projects</option>
          <option value="include">Include hidden</option>
          <option value="only">Hidden only</option>
        </select></label>
        <label>Sort projects<select disabled={settings.busy} value={requested.projectOrder ?? projectOrder} onChange={(event) =>
          changeSetting('projectOrder', event.target.value as DisplayPreferences['projectOrder'])}>
          <option value="byDefault">Default</option>
          <option value="alphabetically">Name</option>
          <option value="byCreationTime">Newest first</option>
        </select></label>
        <label>Projects view<select disabled={settings.busy} value={requested.homeView ?? homeView} onChange={(event) =>
          changeSetting('homeView', event.target.value as DisplayPreferences['homeView'])}>
          <option value="groupedProjects">Grouped</option>
          <option value="gridProjects">Grid</option>
        </select></label>
      </div>
      <div className="workspace-filters">
        <label><input checked={displayedFilters.favorite} onChange={(event) => setFilter('favorite', event.target.checked ? 'true' : null)}
          type="checkbox" />Favorites only</label>
        <label><input checked={requested.showFavorites ?? showFavorites} disabled={settings.busy} type="checkbox"
          onChange={(event) => changeSetting('showFavorites', event.target.checked)} />Show favorites in sidebar</label>
      </div>
      {(settings.problem || favorites.problem) && <p className="workspace-problem" role="alert">{settings.problem || favorites.problem}</p>}
      {projectsPage.data.length > 0 ? <ul className="workspace-projects" data-view={grouped ? 'grouped' : 'grid'}>
        {projectsPage.data.map((project) => <li key={project.id}>
          <ProjectTile project={project} grouped={grouped} open={filters.open === project.id} busy={favorites.busy} scope={data}
            onExpand={() => setFilter('open', filters.open === project.id ? null : project.id)}
            onFavorite={() => void favorites.run((csrf) => saveProjectFavorite(project, !project.favorite, csrf))} />
        </li>)}
      </ul> : <EmptyState title={filters.q ? 'No matching projects' : 'No projects to show'} />}
      {(filters.cursor || projectsPage.page.nextCursor) && <nav aria-label="Project pages" className="workspace-pagination">
        {filters.cursor && <Link to={pageTarget(null)}>First page</Link>}
        {projectsPage.page.nextCursor && <Link to={pageTarget(projectsPage.page.nextCursor)}>Next page</Link>}
      </nav>}
    </section>
  );
}

export function NativeProjectPage() {
  const project = useLoaderData<Awaited<ReturnType<typeof loadNativeProject>>>();
  const favorite = useWorkspaceAction();
  const revalidator = useRevalidator();
  if (!project) return <RouteNotFound />;
  return <section className="page workspace-page" aria-labelledby="page-heading">
    <header className="page-header">
      <nav aria-label="Breadcrumb"><Link to="/workspace">Projects</Link></nav>
      <div className="workspace-detail-title">
        <PageHeading id="page-heading">{project.name}</PageHeading>
        <FavoriteButton project={project} busy={favorite.busy} onToggle={() =>
          void favorite.run((csrf) => saveProjectFavorite(project, !project.favorite, csrf))} />
      </div>
      {project.hidden && <p className="workspace-hidden">Hidden</p>}
      <div className="project-actions"><ProjectSettingsControls key={project.id} project={project} /></div>
    </header>
    {revalidator.state === 'idle' && <ProjectBackgroundPreview project={project} />}
    {favorite.problem && <p className="workspace-problem" role="alert">{favorite.problem}</p>}
    {project.description && <p className="workspace-description">{project.description}</p>}
    {project.boards.length ? <section aria-label="Boards" className="workspace-detail">
      <h2>Boards</h2><BoardLinks boards={project.boards} />
    </section> : <EmptyState title="No boards to show" />}
  </section>;
}
