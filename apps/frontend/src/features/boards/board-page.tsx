import { Link, Outlet, useLocation, useMatch, useSearchParams } from 'react-router';
import { EmptyState, PageHeading } from '../../app/page-state.js';

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
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const inspectorOpen = useMatch('/boards/:boardId/cards/:cardId') !== null;
  const context = contexts.find(({ id }) => id === params.get('context')) ?? contexts[0];
  const availableViews = context.id === 'board' ? views : views.filter(({ id }) => id !== 'kanban');
  const defaultView = context.id === 'board' ? 'kanban' : 'list';
  const view = availableViews.find(({ id }) => id === params.get('view'))?.id ?? defaultView;

  function boardLocation(nextContext: (typeof contexts)[number]['id'], nextView?: View) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('context', nextContext);
    if (nextView) nextParams.set('view', nextView);
    else if (nextContext !== 'board' && nextParams.get('view') === 'kanban') nextParams.delete('view');
    return { pathname, search: `?${nextParams}` };
  }

  return (
    <div className="board-layout" data-inspector-open={inspectorOpen}>
      <section className="page board-page" aria-labelledby="page-heading">
        <header className="page-header">
          <nav aria-label="Breadcrumb"><Link to="/workspace">Projects</Link></nav>
          <PageHeading focus={!inspectorOpen} id="page-heading">Board</PageHeading>
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
        <EmptyState title={context.emptyTitle} />
      </section>
      <Outlet />
    </div>
  );
}
