import { createBrowserRouter, redirect, type RouteObject } from 'react-router';
import { RouteError, RouteNotFound, RoutePending } from './page-state.js';
import { AppShell } from './shell.js';
import { loadBrowserSession } from '../features/auth/browser-session.js';
import {
  loadNativeBoard, loadNativeCard, loadNativeProject, loadWorkspaceNavigation, workspaceBoardId, workspaceNavigationId, workspaceProjectId,
} from '../features/workspace/workspace-loaders.js';

const nativeBrowserAuth = document.querySelector<HTMLMetaElement>('meta[name="planner-browser-auth"]')?.content === 'required';

const workspaceRoutes: RouteObject[] = [
  {
    path: 'workspace',
    lazy: async () => ({ Component: nativeBrowserAuth ? (await import('../features/workspace/workspace-pages.js')).NativeWorkspacePage
      : (await import('../features/projects/project-pages.js')).WorkspacePage }),
  },
  {
    path: 'projects/:projectId',
    ...(nativeBrowserAuth && { id: workspaceProjectId, loader: loadNativeProject }),
    lazy: async () => ({ Component: nativeBrowserAuth ? (await import('../features/workspace/workspace-pages.js')).NativeProjectPage
      : (await import('../features/projects/project-pages.js')).ProjectPage }),
  },
  {
    path: 'boards/:boardId',
    ...(nativeBrowserAuth && { id: workspaceBoardId, loader: loadNativeBoard }),
    lazy: async () => ({ Component: (await import('../features/boards/board-page.js')).BoardPage }),
    children: [{
      path: 'cards/:cardId',
      ...(nativeBrowserAuth && { loader: loadNativeCard }),
      lazy: async () => ({ Component: (await import('../features/boards/card-inspector.js')).CardInspector }),
    }],
  },
];

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
      path: 'enroll-mfa',
      lazy: async () => ({ Component: (await import('../features/auth/auth-pages.js')).StagedMfaPage }),
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
        ...(nativeBrowserAuth ? [{
          id: workspaceNavigationId, loader: loadWorkspaceNavigation, children: workspaceRoutes,
        }] : workspaceRoutes),
        ...(nativeBrowserAuth ? [
          {
            path: 'settings',
            lazy: async () => {
              const { AccountSettingsPage, loadAccountSettings } = await import('../features/accounts/account-settings.js');
              return { Component: AccountSettingsPage, loader: loadAccountSettings };
            },
          },
          {
            path: 'settings/security',
            lazy: async () => {
              const { MfaSettingsPage, loadMfaSettings } = await import('../features/auth/mfa-settings.js');
              return { Component: MfaSettingsPage, loader: loadMfaSettings };
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
