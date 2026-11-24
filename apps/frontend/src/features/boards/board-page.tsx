import { Link, Outlet, useLoaderData, useLocation, useMatch, useSearchParams } from 'react-router';
import { EmptyState, PageHeading, RouteNotFound } from '../../app/page-state.js';

import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import { projectHref } from '../workspace/workspace-navigation.js';
import { BoardManagement } from './board-management.js';

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

type View = (typeof views)[number]['id'];

export function BoardPage() {
  const board = useLoaderData<Awaited<ReturnType<typeof loadNativeBoard>>>();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const inspectorOpen = useMatch('/boards/:boardId/cards/:cardId') !== null;
  const context = contexts.find(({ id }) => id === params.get('context')) ?? contexts[0];
  const availableViews = context.id === 'board' ? views : views.filter(({ id }) => id !== 'kanban');
  const defaultView = context.id === 'board' ? board?.preferences.defaultView ?? 'kanban' : 'list';
  const view = availableViews.find(({ id }) => id === params.get('view'))?.id ?? defaultView;

  function boardLocation(nextContext: (typeof contexts)[number]['id'], nextView?: View) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('context', nextContext);
    if (nextView) nextParams.set('view', nextView);
    else if (nextContext !== 'board' && nextParams.get('view') === 'kanban') nextParams.delete('view');
    return { pathname, search: `?${nextParams}` };
  }

  if (board === null) return <RouteNotFound />;
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
          {board && <BoardManagement key={board.board.id} workspace={board} />}
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
        {lists?.length ? <ul aria-label="Board lists" className="workspace-list-summary">
          {lists.map((list) => <li key={list.id}><strong>{list.name}</strong><span>{list.cardCount} {list.cardCount === 1 ? 'card' : 'cards'}</span></li>)}
        </ul> : <EmptyState title={board ? 'No lists to show' : context.emptyTitle} />}
      </section>
      <Outlet />
    </div>
  );
}
