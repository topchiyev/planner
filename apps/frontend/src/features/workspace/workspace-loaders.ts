import { publicIdSchema } from '@planner/contracts/storage';
import { redirect, type LoaderFunctionArgs } from 'react-router';
import { boardFilterApiQuery, boardFilterLocation, readBoardFilterLocation } from './board-filter-route.js';
import { readWorkspace, readWorkspacePreferences, workspaceSignIn, WorkspaceRequestError } from './workspace-api.js';

export const workspaceNavigationId = 'workspace-navigation';
export const workspaceProjectId = 'workspace-project';
export const workspaceBoardId = 'workspace-board';

function cursorOf(value: string | null) {
  return value && value.length <= 2048 && /^v1\.[A-Za-z0-9_-]+$/u.test(value) ? value : null;
}

export function workspaceFilters(url: URL) {
  const search = url.pathname.replace(/\/$/u, '') === '/workspace' ? url.searchParams : new URLSearchParams();
  const hidden = search.get('hidden');
  return {
    q: search.get('q')?.trim().slice(0, 256) ?? '',
    hidden: hidden === 'include' || hidden === 'only' ? hidden : 'exclude' as const,
    favorite: search.get('favorite') === 'true',
    cursor: cursorOf(search.get('cursor')),
    favoriteCursor: cursorOf(search.get('favoriteCursor')),
    open: publicIdSchema.safeParse(search.get('open')).data,
  };
}

export async function loadWorkspaceNavigation({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const filters = workspaceFilters(url);
  const { signal } = request;
  try {
    const preferences = await readWorkspacePreferences(signal);
    function projects(favorite: boolean, cursor: string | null) {
      const query = new URLSearchParams({ q: filters.q, hidden: filters.hidden, favorite: String(favorite),
        order: preferences.preferences.projectOrder });
      if (cursor) query.set('cursor', cursor);
      return readWorkspace('projectsList', undefined, query, signal);
    }
    const [projectsPage, favoritesPage] = await Promise.all([
      projects(filters.favorite, filters.cursor),
      preferences.preferences.showFavorites ? projects(true, filters.favoriteCursor) : null,
    ]);
    return { filters, preferences, projectsPage, favoritesPage };
  } catch (error) {
    if (error instanceof WorkspaceRequestError && error.status === 401) throw workspaceSignIn(request);
    if (error instanceof WorkspaceRequestError && error.code === 'INVALID_CURSOR' && (filters.cursor || filters.favoriteCursor)) {
      url.searchParams.delete('cursor');
      url.searchParams.delete('favoriteCursor');
      throw redirect(url.pathname + url.search);
    }
    throw error;
  }
}

async function loadVisible<T>(request: Request, read: () => Promise<T>) {
  try { return await read(); }
  catch (error) {
    if (error instanceof WorkspaceRequestError && error.status === 401) throw workspaceSignIn(request);
    if (error instanceof WorkspaceRequestError && error.status === 404) return null;
    throw error;
  }
}

export function loadNativeProject({ params, request }: LoaderFunctionArgs) {
  const id = publicIdSchema.safeParse(params.projectId);
  if (!id.success) return null;
  return loadVisible(request, async () => (await readWorkspace('projectGet', id.data, undefined, request.signal)).data);
}

export async function readNativeBoard(boardId: string, url: URL, signal: AbortSignal, live = false) {
  const { recipe, context, cursor } = readBoardFilterLocation(url.searchParams);
  if (!live && url.searchParams.has('cursor') && !cursor)
    throw redirect(url.pathname + boardFilterLocation(url.search, recipe));
  const workspace = await readWorkspace('boardWorkspace', boardId, undefined, signal);
  const base = { ...workspace.data, recipe, recipeCursor: cursor, context };
  try {
    const cardsPage = await readWorkspace('boardCards', boardId, boardFilterApiQuery(context, recipe, cursor), signal);
    return { ...base, cardsPage };
  } catch (error) {
    if (!(error instanceof WorkspaceRequestError)) throw error;
    if (error.code === 'INVALID_CURSOR' && cursor && !live)
      throw redirect(url.pathname + boardFilterLocation(url.search, recipe));
    if (error.status === 403 || error.status === 404) return null;
    if (error.status === 401 || live) throw error;
    return { ...base, cardsPage: null };
  }
}

export function loadNativeBoard({ params, request }: LoaderFunctionArgs) {
  const id = publicIdSchema.safeParse(params.boardId);
  if (!id.success) return null;
  return loadVisible(request, () => readNativeBoard(id.data, new URL(request.url), request.signal));
}

export async function readNativeCard(boardId: string, id: string, signal: AbortSignal) {
  const query = new URLSearchParams({ boardId });
  try {
    const card = (await readWorkspace('cardGet', id, query, signal)).data;
    if (card.boardId !== boardId) return null;
    const checklists = (await readWorkspace('cardChecklists', id, query, signal)).data;
    return { ...card, checklists };
  } catch (error) {
    if (error instanceof WorkspaceRequestError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

export type BoardReadRefusal = {
  deniedBoard: Awaited<ReturnType<typeof loadNativeBoard>> | undefined;
  refuseBoard: (board: NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>) => void;
};

export function loadNativeCard({ params, request }: LoaderFunctionArgs) {
  const boardId = publicIdSchema.safeParse(params.boardId);
  const id = publicIdSchema.safeParse(params.cardId);
  if (!boardId.success || !id.success) return null;
  return loadVisible(request, () => readNativeCard(boardId.data, id.data, request.signal));
}
