import { PLANNER_VERSION } from '@planner/contracts';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLoaderData, useLocation, useNavigation, useRouteLoaderData } from 'react-router';

import { BoardClipboardProvider } from '../features/cards/card-clipboard-state.js';
import { clearBoardRecipes } from '../features/boards/board-filter-store.js';
import { InboxLink } from '../features/discussions/inbox-link.js';
import { WorkspaceSidebar } from '../features/workspace/workspace-navigation.js';
import { workspaceBoardId, type BoardPresentation, type BoardReadRefusal } from '../features/workspace/workspace-loaders.js';
import { sessionPath, type loadBrowserSession } from '../features/auth/browser-session.js';

function clearSignedOutTab() {
  clearBoardRecipes();
  window.location.replace('/sign-in');
}

export function AppShell() {
  const session = useLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [presentation, presentBoard] = useState<BoardPresentation>();
  const [deniedBoard, refuseBoard] = useState<BoardReadRefusal['deniedBoard']>();
  const board = useRouteLoaderData<BoardReadRefusal['deniedBoard']>(workspaceBoardId);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const sessionChannel = useRef<BroadcastChannel>(null);
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const actorScope = session && session.account.id + '/' + session.account.role;
  const authenticated = !!session;
  const liveBoard = presentation?.source === board ? presentation?.board : undefined;
  const refusedBoard = !!board && (deniedBoard === board || liveBoard === null);
  const changingNativePage = authenticated && !!navigation.location && navigation.location.pathname !== pathname;

  useEffect(() => {
    if (!authenticated || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('planner.browser-session');
    sessionChannel.current = channel;
    channel.onmessage = (event) => { if (event.data === 'signed-out') clearSignedOutTab(); };
    return () => { sessionChannel.current = null; channel.close(); };
  }, [authenticated]);

  function closeSidebar() {
    setSidebarOpen(false);
    sidebarToggle.current?.focus();
  }

  async function signOut() {
    if (!session || signingOut) return;
    setSigningOut(true);
    setSignOutError(false);
    try {
      const response = await fetch(sessionPath, {
        method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken }, cache: 'no-store',
      });
      if (response.ok || response.status === 401) {
        sessionChannel.current?.postMessage('signed-out');
        clearSignedOutTab();
      } else setSignOutError(true);
    } catch { setSignOutError(true); }
    finally { setSigningOut(false); }
  }

  return (
    <div className="app-shell" data-version={PLANNER_VERSION} data-native-workspace={!!session}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="mobile-header">
        <button
          aria-controls="project-sidebar"
          aria-expanded={sidebarOpen}
          className="menu-toggle"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          ref={sidebarToggle}
          type="button"
        >
          <span className="menu-icon" aria-hidden="true" />
          Menu
        </button>
        <span className="mobile-brand">Planner</span>
      </header>
      <aside className="project-sidebar" data-open={sidebarOpen} id="project-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true" />
          Planner
        </div>
        <nav
          aria-label="Project navigation"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && sidebarOpen) closeSidebar();
          }}
        >
          <NavLink
            className="workspace-link"
            end
            onClick={() => {
              if (pathname === '/workspace' && sidebarOpen) closeSidebar();
              else setSidebarOpen(false);
            }}
            to="/workspace"
          >
            <span className="projects-icon" aria-hidden="true" />
            Projects
          </NavLink>
          {session && <InboxLink key={actorScope} actorId={session.account.id} follow={() => setSidebarOpen(false)} />}
          {session && !changingNativePage && !refusedBoard && <WorkspaceSidebar key={actorScope} currentBoard={liveBoard ?? undefined} onFollow={() => setSidebarOpen(false)} />}
        </nav>
        {session && (
          <div className="sidebar-account">
            <span>{session.account.name}</span>
            <NavLink onClick={() => setSidebarOpen(false)} to="/settings">Account settings</NavLink>
            {session.account.role !== 'boardUser' && <NavLink onClick={() => setSidebarOpen(false)} to="/admin/accounts">
              {session.account.role === 'admin' ? 'Manage accounts' : 'Account directory'}
            </NavLink>}
            <button disabled={signingOut} onClick={() => void signOut()} type="button">Sign out</button>
            {signOutError && <p role="alert">Couldn’t sign out. Try again.</p>}
          </div>
        )}
        <span className="sidebar-version">Version {PLANNER_VERSION}</span>
      </aside>
      <main className="main-content" id="main-content" tabIndex={-1}>
        {navigation.state !== 'idle' && <p className="navigation-status" role="status">Loading…</p>}
        <BoardClipboardProvider key={actorScope}>{!changingNativePage &&
          <Outlet context={{ deniedBoard, refuseBoard, presentBoard } satisfies BoardReadRefusal} />}</BoardClipboardProvider>
      </main>
    </div>
  );
}
