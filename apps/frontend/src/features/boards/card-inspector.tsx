import { Link, useLoaderData, useLocation, useOutletContext, useRouteLoaderData } from 'react-router';
import type { loadNativeCard } from '../workspace/workspace-loaders.js';
import type { loadBrowserSession } from '../auth/browser-session.js';
import { CardAffiliationControls } from '../affiliations/card-affiliation-controls.js';
import { CardInspectorTransitions } from '../cards/card-inspector-transitions.js';
import { CardFields } from '../fields/workspace-fields.js';
import { CardChecklists } from '../checklists/card-checklists.js';
import { CardAttachments } from '../media/card-attachments.js';
import { CardComments } from '../discussions/comments.js';
import { ActivityFeed } from '../discussions/feed.js';
import { CardClipboardActions, clipboardShortcut, selectClipboardCard } from '../cards/card-clipboard.js';
import { useBoardClipboard } from '../cards/card-clipboard-state.js';
import { CardEditing } from '../cards/card-editing.js';
import type { BoardInspectorContext } from './board-page.js';
import { PageHeading } from '../../app/page-state.js';

export function CardInspector() {
  const initial = useLoaderData<Awaited<ReturnType<typeof loadNativeCard>>>();
  const { board: workspace, liveCard } = useOutletContext<BoardInspectorContext>();
  const card = liveCard === undefined ? initial : liveCard;
  const { search, state } = useLocation();
  const session = useRouteLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>('app-shell');
  const clipboard = useBoardClipboard();
  const scope = [session?.account.id, workspace?.recipeScope, card?.boardId, card?.id].join('/');
  return (
    <aside className="card-inspector" aria-labelledby="card-heading" onKeyDown={(event) => {
      if (!workspace || !card || !clipboard || clipboard.busy) return;
      const shortcut = clipboardShortcut(event);
      if (shortcut && shortcut !== 'paste' && selectClipboardCard(shortcut, card, workspace.recipeScope, clipboard.select)) event.preventDefault();
    }}>
      <header className="inspector-header">
        <PageHeading id="card-heading" level="h2">{card?.name ?? (card === null ? 'Page not found' : 'Card')}</PageHeading>
        <Link aria-label="Close card" className="close-card" to={{ pathname: '..', search }} state={{ cardReturnKey: state?.cardReturnKey }}>
          <span aria-hidden="true">×</span>
        </Link>
      </header>
      {card && typeof state?.transferNotice === 'string' && <p className="inspector-status" role="status">{state.transferNotice}</p>}
      {card === undefined && <p className="inspector-status">Card details are unavailable.</p>}
      {card && workspace && <CardClipboardActions card={card} scope={workspace.recipeScope} />}
      {card && workspace && <CardInspectorTransitions key={'placement:' + scope} card={card} workspace={workspace} />}
      {card && workspace && <CardAffiliationControls key={`affiliations:${scope}`} card={card} workspace={workspace} />}
      {card && <CardEditing key={'content:' + scope} card={card} restriction={workspace?.preferences.restrictedCardType} draftScope={workspace?.recipeScope} />}
      {card && <CardAttachments key={`attachments:${scope}`} card={card} />}
      {card && <CardChecklists key={`checklists:${scope}`}
        card={card} groups={card.checklists} expand={workspace?.preferences.expandChecklists ?? false} />}
      {card && <CardComments key={`comments:${scope}`} card={card} />}
      {card && <ActivityFeed key={`activity:${scope}`}
        id={card.id} revision={card.revision} boardId={card.boardId} />}
      {card && <CardFields key={`fields:${scope}`} card={card} project={workspace?.project} />}
    </aside>
  );
}
