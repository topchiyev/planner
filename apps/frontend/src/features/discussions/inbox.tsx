import { Link, redirect, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { WorkspaceReadOutput } from '@planner/contracts';
import { PageHeading } from '../../app/page-state.js';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import { readWorkspace, workspaceSignIn, WorkspaceRequestError } from '../workspace/workspace-api.js';
import { feedCardHref, FeedTime } from './feed.js';

type Notice = WorkspaceReadOutput<'notificationsList'>['data'][number];
const noticeTitles = { moveCard: 'moved a card you follow', assignCard: 'assigned you to this card',
  commentCard: 'commented on a card you follow', mentionInComment: 'mentioned you in a comment' };

function inboxPath(unread: boolean, cursor?: string | null) {
  const params = new URLSearchParams();
  if (unread) params.set('unread', 'true');
  if (cursor) params.set('cursor', cursor);
  return '/inbox' + (params.size ? '?' + params : '');
}

export async function loadInbox({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  const unread = params.get('unread') === 'true';
  const cursor = params.get('cursor') ?? undefined;
  const query = new URLSearchParams({ unread: String(unread), limit: '20' });
  if (cursor) query.set('cursor', cursor);
  try {
    return { ...(await readWorkspace('notificationsList', undefined, query, request.signal)), unread, cursor };
  } catch (error) {
    if (error instanceof WorkspaceRequestError && error.status === 401) throw workspaceSignIn(request);
    if (error instanceof WorkspaceRequestError && cursor && (error.code === 'INVALID_CURSOR' || error.code === 'INVALID_REQUEST')) {
      throw redirect(inboxPath(unread));
    }
    throw error;
  }
}

export function InboxPage() {
  const inbox = useLoaderData<Awaited<ReturnType<typeof loadInbox>>>();
  const action = useWorkspaceMutation(new Map(), 'This notification or your access changed. The inbox has been refreshed.');
  const grouped = new Map<string, Notice[]>();
  for (const notice of inbox.data) {
    const group = grouped.get(notice.card.id) ?? [];
    group.push(notice);
    grouped.set(notice.card.id, group);
  }

  function markAll() {
    void action.run(['notifications.readAll'], (csrf, key) => relationshipCommand('notifications.readAll', csrf, key));
  }
  function markCard(id: string) {
    void action.run(['notifications.readCard', id], (csrf, key) => relationshipCommand('notifications.readCard', csrf, key, { id }));
  }
  function markNotice(notice: Notice, read: boolean) {
    const { id, revision } = notice;
    const body = { read };
    void action.run(['notifications.update', id, revision, body], (csrf, key) =>
      relationshipCommand('notifications.update', csrf, key, { id, revision, body }));
  }

  return <section className="page inbox-page" aria-labelledby="page-heading">
    <PageHeading id="page-heading">Inbox</PageHeading>
    <div className="inbox-toolbar">
      <nav className="context-nav" aria-label="Inbox filter">
        <Link aria-current={!inbox.unread ? 'page' : undefined} to={inboxPath(false)}>All</Link>
        <Link aria-current={inbox.unread ? 'page' : undefined} to={inboxPath(true)}>Unread{inbox.unreadCount ? ' · ' + inbox.unreadCount : ''}</Link>
      </nav>
      {inbox.unreadCount > 0 && <button className="workspace-button" type="button" disabled={action.busy} onClick={markAll}>Mark all read</button>}
    </div>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {!inbox.data.length && <p>{inbox.unread ? 'No unread notifications.' : 'No notifications.'}</p>}
    <div className="inbox-groups">
      {[...grouped.values()].map((notices) => {
        const { card } = notices[0];
        return <section key={card.id} aria-label={card.name} className="inbox-group">
          <header>
            <h2><Link to={feedCardHref(card)}>{card.name}</Link></h2>
            {notices.some(({ readAt }) => readAt === null) && <button className="workspace-button" type="button"
              disabled={action.busy} onClick={() => markCard(card.id)}>Mark card read</button>}
          </header>
          <ol className="feed-entries">
            {notices.map((notice) => <li key={notice.id} className="inbox-notification" data-unread={notice.readAt === null}>
              <div>
                <p><strong>{notice.actor?.name ?? 'Unknown account'}</strong> {noticeTitles[notice.kind]}.</p>
                <FeedTime value={notice.createdAt} />
              </div>
              <button className="workspace-button" type="button" disabled={action.busy}
                onClick={() => markNotice(notice, notice.readAt === null)}>{notice.readAt === null ? 'Mark read' : 'Mark unread'}</button>
            </li>)}
          </ol>
        </section>;
      })}
    </div>
    {(inbox.cursor || inbox.page.nextCursor) && <nav aria-label="Inbox pages" className="project-actions">
      {inbox.cursor && <Link className="workspace-button" to={inboxPath(inbox.unread)}>First page</Link>}
      {inbox.page.nextCursor && <Link className="workspace-button" to={inboxPath(inbox.unread, inbox.page.nextCursor)}>Older notifications</Link>}
    </nav>}
  </section>;
}
