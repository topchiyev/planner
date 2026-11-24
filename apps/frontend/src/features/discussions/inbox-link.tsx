import { useEffect, useState } from 'react';
import { NavLink, useLocation, useRevalidator } from 'react-router';
import { readWorkspace } from '../workspace/workspace-api.js';
import './discussions.css';

export function InboxLink({ actorId, follow }: { actorId: string; follow: () => void }) {
  const { key } = useLocation();
  const { state } = useRevalidator();
  const [badge, setBadge] = useState<{ actorId: string; key: string; unread: number }>();
  useEffect(() => {
    if (state !== 'idle') return;
    const controller = new AbortController();
    const params = new URLSearchParams({ unread: 'true', limit: '1' });
    void readWorkspace('notificationsList', undefined, params, controller.signal).then(({ unreadCount }) => {
      if (!controller.signal.aborted) setBadge({ actorId, key, unread: unreadCount });
    }).catch(() => { if (!controller.signal.aborted) setBadge(undefined); });
    return () => controller.abort();
  }, [actorId, key, state]);
  const unread = badge?.actorId === actorId && badge.key === key ? badge.unread : 0;
  return <NavLink className="workspace-link inbox-link" end to="/inbox" onClick={follow}
    aria-label={unread ? 'Inbox, ' + unread + ' unread' : 'Inbox'}>
    Inbox{unread > 0 && <span className="inbox-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
  </NavLink>;
}
