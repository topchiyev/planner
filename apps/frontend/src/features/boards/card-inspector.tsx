import { Link, useLoaderData, useLocation, useRouteLoaderData } from 'react-router';
import { workspaceBoardId, type loadNativeBoard, type loadNativeCard } from '../workspace/workspace-loaders.js';
import type { loadBrowserSession } from '../auth/browser-session.js';
import { CardAffiliationControls } from '../affiliations/card-affiliation-controls.js';
import { CardInspectorTransitions } from '../cards/card-inspector-transitions.js';
import { CardFields } from '../fields/workspace-fields.js';
import { CardChecklists } from '../checklists/card-checklists.js';
import { CardAttachments } from '../media/card-attachments.js';
import { CardComments } from '../discussions/comments.js';
import { ActivityFeed } from '../discussions/feed.js';
import { CardEditing } from '../cards/card-editing.js';
import { PageHeading } from '../../app/page-state.js';

export function CardInspector() {
  const card = useLoaderData<Awaited<ReturnType<typeof loadNativeCard>>>();
  const workspace = useRouteLoaderData<Awaited<ReturnType<typeof loadNativeBoard>>>(workspaceBoardId);
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
      {card && workspace && <CardInspectorTransitions key={card.id} card={card} workspace={workspace} />}
      {card && workspace && <CardAffiliationControls key={`affiliations:${session?.account.id}:${card.boardId}:${card.id}`} card={card} workspace={workspace} />}
      {card && <CardEditing key={`${session?.account.id}:${card.boardId}:${card.id}`} card={card} />}
      {card && <CardAttachments key={`attachments:${session?.account.id}:${card.boardId}:${card.id}`} card={card} />}
      {card && <CardChecklists key={`checklists:${session?.account.id}:${card.boardId}:${card.id}`}
        card={card} groups={card.checklists} expand={workspace?.preferences.expandChecklists ?? false} />}
      {card && <CardComments key={`comments:${session?.account.id}:${card.boardId}:${card.id}`} card={card} />}
      {card && <ActivityFeed key={`activity:${session?.account.id}:${card.boardId}:${card.id}`}
        id={card.id} revision={card.revision} boardId={card.boardId} />}
      {card && <CardFields key={`fields:${session?.account.id}:${card.boardId}:${card.id}`} card={card} project={workspace?.project} />}
    </aside>
  );
}
