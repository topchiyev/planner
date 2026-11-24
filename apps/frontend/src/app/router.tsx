import { createBrowserRouter, redirect } from 'react-router';
import { RouteError, RouteNotFound, RoutePending } from './page-state.js';
import { AppShell } from './shell.js';
import { loadBrowserSession } from '../features/auth/browser-session.js';

const nativeBrowserAuth = document.querySelector<HTMLMetaElement>('meta[name="planner-browser-auth"]')?.content === 'required';

export const router = createBrowserRouter([
  ...(nativeBrowserAuth ? [
    {
      path: 'recover',
      lazy: async () => ({ Component: (await import('../features/auth/auth-pages.js')).FirstAdminPage }),
    },
    {
      path: 'account-recovery',
      lazy: async () => ({ Component: (await import('../features/auth/auth-pages.js')).AccountRecoveryPage }),
    },
    {
      path: 'sign-in',
      lazy: async () => ({ Component: (await import('../features/auth/auth-pages.js')).SignInPage }),
    },
  ] : []),
  {
    id: 'app-shell',
    Component: AppShell,
    ...(nativeBrowserAuth && {
      loader: loadBrowserSession,
      shouldRevalidate: ({ currentUrl, nextUrl, defaultShouldRevalidate }) =>
        currentUrl.pathname !== nextUrl.pathname || defaultShouldRevalidate,
      ErrorBoundary: RouteError,
      HydrateFallback: RoutePending,
    }),
    children: [{
      ErrorBoundary: RouteError,
      HydrateFallback: RoutePending,
      children: [
        { index: true, loader: () => redirect('/workspace') },
        {
          path: 'workspace',
          lazy: async () => ({ Component: (await import('../features/projects/project-pages.js')).WorkspacePage }),
        },
        {
          path: 'projects/:projectId',
          lazy: async () => ({ Component: (await import('../features/projects/project-pages.js')).ProjectPage }),
        },
        {
          path: 'boards/:boardId',
          lazy: async () => ({ Component: (await import('../features/boards/board-page.js')).BoardPage }),
          children: [{
            path: 'cards/:cardId',
            lazy: async () => ({ Component: (await import('../features/boards/card-inspector.js')).CardInspector }),
          }],
        },
        ...(nativeBrowserAuth ? [
          {
            path: 'settings',
            lazy: async () => {
              const { AccountSettingsPage, loadAccountSettings } = await import('../features/accounts/account-settings.js');
              return { Component: AccountSettingsPage, loader: loadAccountSettings };
            },
          },
          {
            path: 'admin/accounts',
            lazy: async () => {
              const { AccountDirectoryPage, loadAccountDirectory } = await import('../features/accounts/account-directory.js');
              return { Component: AccountDirectoryPage, loader: loadAccountDirectory };
            },
          },
        ] : []),
        { path: '*', Component: RouteNotFound },
      ],
    }],
  },
]);
