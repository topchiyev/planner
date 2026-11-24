import { PLANNER_VERSION } from '@planner/contracts';
import { useRef, useState } from 'react';
import { NavLink, Outlet, useLoaderData, useLocation, useNavigation } from 'react-router';

import { sessionPath, type loadBrowserSession } from '../features/auth/browser-session.js';

export function AppShell() {
  const session = useLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const navigation = useNavigation();

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
      if (response.ok || response.status === 401) window.location.replace('/sign-in');
      else setSignOutError(true);
    } catch { setSignOutError(true); }
    finally { setSigningOut(false); }
  }

  return (
    <div className="app-shell" data-version={PLANNER_VERSION}>
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
        </nav>
        {session && (
          <div className="sidebar-account">
            <span>{session.account.name}</span>
            <button disabled={signingOut} onClick={() => void signOut()} type="button">Sign out</button>
            {signOutError && <p role="alert">Couldn’t sign out. Try again.</p>}
          </div>
        )}
        <span className="sidebar-version">Version {PLANNER_VERSION}</span>
      </aside>
      <main className="main-content" id="main-content" tabIndex={-1}>
        {navigation.state !== 'idle' && <p className="navigation-status" role="status">Loading…</p>}
        <Outlet />
      </main>
    </div>
  );
}
