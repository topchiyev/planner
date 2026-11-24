import { Link, Outlet, useLoaderData, useLocation, useMatch, useNavigation, useOutletContext, useRevalidator, useSearchParams } from 'react-router';
import { EmptyState, PageHeading, RouteNotFound } from '../../app/page-state.js';

import type { BoardReadRefusal, loadNativeBoard } from '../workspace/workspace-loaders.js';
import { projectHref } from '../workspace/workspace-navigation.js';
import { BoardAffiliations } from '../affiliations/board-affiliations.js';
import { BoardManagement } from './board-management.js';
import { BoardFieldGroups } from '../fields/workspace-fields.js';
import { ActivityFeed } from '../discussions/feed.js';
import { BoardFilters } from './board-filters.js';
import { BoardCards, type BoardView } from '../cards/board-cards.js';

const contexts = [
  { id: 'board', name: 'Board', emptyTitle: 'No cards to show' },
  { id: 'archive', name: 'Archive', emptyTitle: 'No archived cards to show' },
  { id: 'trash', name: 'Trash', emptyTitle: 'No trashed cards to show' },
] as const;

const views = [
  { id: 'kanban', name: 'Kanban' },
  { id: 'grid', name: 'Grid' },
  { id: 'list', name: 'List' },
] as const;



export function BoardPage() {
  const board = useLoaderData<Awaited<ReturnType<typeof loadNativeBoard>>>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const { deniedBoard, refuseBoard } = useOutletContext<BoardReadRefusal>();
  const { pathname, search, state: routeState } = useLocation();
  const pending = !!navigation.location && (navigation.location.pathname !== pathname || navigation.location.search !== search);
  const inspectorOpen = useMatch('/boards/:boardId/cards/:cardId') !== null;
  const context = contexts.find(({ id }) => id === params.get('context')) ?? contexts[0];
  const availableViews = context.id === 'board' ? views : views.filter(({ id }) => id !== 'kanban');
  const defaultView = context.id === 'board' ? board?.preferences.defaultView ?? 'kanban' : 'list';
  const view = availableViews.find(({ id }) => id === params.get('view'))?.id ?? defaultView;

  function boardLocation(nextContext: (typeof contexts)[number]['id'], nextView?: BoardView) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('context', nextContext);
    if (nextContext !== context.id) {
      nextParams.delete('cursor');
      nextParams.delete('listIds');
    }
    if (nextView) nextParams.set('view', nextView);
    else if (nextContext !== 'board' && nextParams.get('view') === 'kanban') nextParams.delete('view');
    return { pathname, search: `?${nextParams}` };
  }

  if (board === null || (board && deniedBoard === board)) return <RouteNotFound />;
  const lists = board?.lists.filter(({ kind }) => context.id === 'board' ? kind === 'active' || kind === 'closed' : kind === context.id);

  return (
    <div className="board-layout" data-inspector-open={inspectorOpen}>
      <section className="page board-page" aria-labelledby="page-heading">
        <header className="page-header">
          <nav aria-label="Breadcrumb" className="workspace-breadcrumb">
            <Link to="/workspace">Projects</Link>
            {board && <Link to={projectHref(board.project.id)}>{board.project.name}</Link>}
          </nav>
          <PageHeading focus={!inspectorOpen} id="page-heading">{board?.board.name ?? 'Board'}</PageHeading>
          {!inspectorOpen && typeof routeState?.transferNotice === 'string' && <p role="status">{routeState.transferNotice}</p>}
          {board && <BoardManagement key={board.board.id} workspace={board} />}
          {board && <BoardAffiliations key={'affiliations:' + board.board.id} workspace={board} />}
          {board && <BoardFieldGroups key={'fields:' + board.board.id} workspace={board} />}
        </header>
        <div className="board-controls">
          <nav aria-label="Board context" className="context-nav">
            {contexts.map((item) => (
              <Link aria-current={item.id === context.id ? 'page' : undefined} key={item.id} to={boardLocation(item.id)}>{item.name}</Link>
            ))}
          </nav>
          <nav aria-label="Board view" className="view-nav">
            {availableViews.map((item) => (
              <Link aria-current={item.id === view ? 'page' : undefined} key={item.id} to={boardLocation(context.id, item.id)}>{item.name}</Link>
            ))}
          </nav>
        </div>
        {board && lists ? <>
          <BoardFilters key={JSON.stringify([board.recipeScope, board.board.id, board.context, board.recipe])}
            workspace={board} lists={lists} loading={pending} onAccessLost={() => {
              refuseBoard(board);
              void revalidator.revalidate();
            }} />
          <div hidden={pending}>
            <BoardCards key={board.board.id + ':' + context.id} workspace={board} lists={lists} context={context.id} view={view} />
          </div>
        </> : !board && <EmptyState title={context.emptyTitle} />}
        {board && <ActivityFeed key={board.board.id} id={board.board.id} revision={board.board.revision} />}
      </section>
      <Outlet />
    </div>
  );
}
