import { Link, NavLink, useLocation, useMatches, useRouteLoaderData } from 'react-router';
import { CreateProjectButton } from '../projects/project-create.js';
import { type BoardSummary, type ProjectSummary } from './workspace-api.js';
import {
  type loadNativeBoard, type loadNativeProject, type loadWorkspaceNavigation, workspaceBoardId, workspaceNavigationId, workspaceProjectId,
} from './workspace-loaders.js';
import './workspace.css';

export const projectHref = (id: string) => '/projects/' + id;
export const boardHref = (id: string) => '/boards/' + id;

export function useWorkspaceNavigation() {
  return useRouteLoaderData<Awaited<ReturnType<typeof loadWorkspaceNavigation>>>(workspaceNavigationId);
}

type BoardSnapshot = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;

function useWorkspaceSelection(currentBoard?: BoardSnapshot) {
  const matches = useMatches();
  const project = matches.find(({ id }) => id === workspaceProjectId)?.loaderData as
    Awaited<ReturnType<typeof loadNativeProject>> | undefined;
  const loadedBoard = matches.find(({ id }) => id === workspaceBoardId)?.loaderData as
    Awaited<ReturnType<typeof loadNativeBoard>> | undefined;
  const board = currentBoard ?? loadedBoard;
  return { project: project ?? board?.project, board: board?.board };
}

export function BoardLinks({ boards, className }: { boards: BoardSummary[]; className?: string }) {
  return (
    <ul className={className ?? 'workspace-board-links'}>
      {boards.map(({ id, name }) => <li key={id}><Link to={boardHref(id)}>{name}</Link></li>)}
    </ul>
  );
}

export function WorkspaceSidebar({ onFollow, currentBoard }: { onFollow: () => void; currentBoard?: BoardSnapshot }) {
  const location = useLocation();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection(currentBoard);
  if (!navigation) return null;
  const normal = navigation.projectsPage.data;
  const projects = selection.project && !normal.some(({ id }) => id === selection.project?.id)
    ? [...normal, selection.project] : normal;
  const favoriteCursor = navigation.favoritesPage?.page.nextCursor;
  const favorites = navigation.favoritesPage?.data ?? [];
  const query = location.pathname.replace(/\/$/u, '') === '/workspace' ? new URLSearchParams(location.search) : new URLSearchParams();
  query.delete('favoriteCursor');
  const firstFavoritePage = '/workspace' + (query.size ? '?' + query : '');
  if (favoriteCursor) query.set('favoriteCursor', favoriteCursor);
  function projectLinks(rows: ProjectSummary[], showBoard: boolean) {
    return <ul className="sidebar-projects">
      {rows.map((row) => (
        <li key={row.id} data-selected={selection.project?.id === row.id}>
          <NavLink end onClick={onFollow} to={projectHref(row.id)}>{row.name}</NavLink>
          {showBoard && selection.project?.id === row.id && selection.board &&
            <NavLink className="sidebar-active-board" onClick={onFollow} to={boardHref(selection.board.id)}>
              {selection.board.name}
            </NavLink>}
        </li>
      ))}
    </ul>;
  }
  return (
    <>
      {navigation.projectsPage.permissions.canCreate && <CreateProjectButton onCreated={onFollow} />}
      {projects.length > 0 && <div aria-label="Project list" role="group">{projectLinks(projects, true)}</div>}
      {navigation.favoritesPage && (favorites.length > 0 || navigation.filters.favoriteCursor) && <div className="sidebar-favorites" aria-label="Favorites" role="group">
        <h2>Favorites</h2>
        {projectLinks(favorites, false)}
        {navigation.filters.favoriteCursor && <Link className="sidebar-more" onClick={onFollow} to={firstFavoritePage}>First favorites page</Link>}
        {favoriteCursor && <Link className="sidebar-more" onClick={onFollow} to={'/workspace?' + query}>More favorites</Link>}
      </div>}
    </>
  );
}
