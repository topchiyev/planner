import { createBrowserRouter, redirect } from 'react-router';
import { RouteError, RouteNotFound, RoutePending } from './page-state.js';
import { AppShell } from './shell.js';

export const router = createBrowserRouter([
  {
    Component: AppShell,
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
        { path: '*', Component: RouteNotFound },
      ],
    }],
  },
]);
