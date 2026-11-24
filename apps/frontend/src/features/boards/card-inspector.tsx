import { Link, useLoaderData, useLocation, useRouteLoaderData } from 'react-router';
import type { loadNativeCard } from '../workspace/workspace-loaders.js';
import type { loadBrowserSession } from '../auth/browser-session.js';
import { CardEditing } from '../cards/card-editing.js';
import { PageHeading } from '../../app/page-state.js';

export function CardInspector() {
  const card = useLoaderData<Awaited<ReturnType<typeof loadNativeCard>>>();
  const { search } = useLocation();
  const session = useRouteLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>('app-shell');
  return (
    <aside className="card-inspector" aria-labelledby="card-heading">
      <header className="inspector-header">
        <PageHeading id="card-heading" level="h2">{card?.name ?? (card === null ? 'Page not found' : 'Card')}</PageHeading>
        <Link aria-label="Close card" className="close-card" to={{ pathname: '..', search }}>
          <span aria-hidden="true">×</span>
        </Link>
      </header>
      {card === undefined && <p className="inspector-status">Card details are unavailable.</p>}
      {card && <CardEditing key={`${session?.account.id}:${card.boardId}:${card.id}`} card={card} />}
    </aside>
  );
}
