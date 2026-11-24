import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { loadBrowserSession } from '../auth/browser-session.js';
import { Link, Outlet, useLoaderData, useLocation, useMatch, useNavigation, useOutletContext, useParams, useRouteLoaderData, useSearchParams } from 'react-router';
import { EmptyState, PageHeading, RouteNotFound } from '../../app/page-state.js';

import type { BoardReadRefusal, loadNativeBoard } from '../workspace/workspace-loaders.js';
import { projectHref } from '../workspace/workspace-navigation.js';
import { BoardAffiliations } from '../affiliations/board-affiliations.js';
import { BoardManagement } from './board-management.js';
import { BoardFieldGroups } from '../fields/workspace-fields.js';
import { ActivityFeed } from '../discussions/feed.js';
import { BoardFilters } from './board-filters.js';
import { BoardCards, cardOpenerId, getCardOpener, type BoardView } from '../cards/board-cards.js';
import { BoardPasteControls, clipboardShortcut, selectClipboardCard } from '../cards/card-clipboard.js';
import { useBoardClipboard } from '../cards/card-clipboard-state.js';
import { BoardRefreshContext } from './board-refresh.js';
import { readBoardView, saveBoardView } from './board-filter-store.js';
import { useLiveBoard, type LiveBoard, type LiveCard } from './use-live-board.js';

export type BoardInspectorContext = { board: LiveBoard | null | undefined; liveCard: LiveCard | undefined };

const contexts = [
  { id: 'board', name: 'Board', emptyTitle: 'No cards to show' },
  { id: 'archive', name: 'Archive', emptyTitle: 'No archived cards to show' },
  { id: 'trash', name: 'Trash', emptyTitle: 'No trashed cards to show' },
] as const;

const views = [
  { id: 'kanban', name: 'Kanban' },
  { id: 'grid', name: 'Grid' },
  { id: 'list', name: 'List' },
] as const;

export function BoardPage() {
  const initial = useLoaderData<Awaited<ReturnType<typeof loadNativeBoard>>>();
  const [params] = useSearchParams();
  const { boardId } = useParams();
  const clipboard = useBoardClipboard();
  const paste = useRef<HTMLButtonElement>(null);
  const navigation = useNavigation();
  const { deniedBoard, refuseBoard, presentBoard } = useOutletContext<BoardReadRefusal>();
  const { key, pathname, search, state: routeState } = useLocation();
  const session = useRouteLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>('app-shell');
  const pending = !!navigation.location && (navigation.location.pathname !== pathname || navigation.location.search !== search);
  const cardId = useMatch('/boards/:boardId/cards/:cardId')?.params.cardId;
  const inspectorOpen = !!cardId;
  const live = useLiveBoard({ initial, actorId: session?.account.id, cardId, location: pathname + search });
  const concealed = live.phase === 'checking' || live.phase === 'unavailable';
  const board = live.board;
  useLayoutEffect(() => {
    if (initial && live.phase === 'missing') refuseBoard(initial);
    else if (initial && deniedBoard === initial && live.phase === 'visible' && board !== initial) refuseBoard(undefined);
    presentBoard(initial && (concealed || board !== initial)
      ? { source: initial, board: concealed ? null : board ?? null } : undefined);
    return () => presentBoard(undefined);
  }, [initial, board, deniedBoard, live.phase, concealed, refuseBoard, presentBoard]);
  useEffect(() => {
    const selected = clipboard?.selected;
    if (!selected) return;
    if (board && board.recipeScope !== selected.scope) { clipboard.discard(selected); return; }
    if (selected.boardId !== boardId) return;
    if (initial === null || live.phase === 'missing') { clipboard.discard(selected); return; }
    if (clipboard.attempt || live.phase !== 'visible') return;
    const source = live.card?.id === selected.cardId ? live.card : board?.cardsPage?.data.find(({ id }) => id === selected.cardId);
    const permitted = source && (selected.action === 'cut' ? source.permissions.canMove : source.permissions.canDuplicateFrom);
    if (live.removed?.has(selected.cardId) || (cardId === selected.cardId && live.card === null) || (source && !permitted)) {
      clipboard.discard(selected);
    }
  }, [clipboard, board, boardId, initial, live.phase, cardId, live.card, live.removed]);
  const context = contexts.find(({ id }) => id === params.get('context')) ?? contexts[0];
  const availableViews = context.id === 'board' ? views : views.filter(({ id }) => id !== 'kanban');
  const defaultView = context.id === 'board' ? board?.preferences.defaultView ?? 'kanban' : 'list';
  const viewKey = board && [board.recipeScope, board.board.id, context.id].join('/');
  const explicitView = availableViews.find(({ id }) => id === params.get('view'))?.id;
  const storedView = viewKey && readBoardView(viewKey);
  const view = explicitView ?? availableViews.find(({ id }) => id === storedView)?.id ?? defaultView;

  useEffect(() => {
    if (viewKey && explicitView) saveBoardView(viewKey, explicitView);
  }, [viewKey, explicitView]);

  useEffect(() => {
    if (inspectorOpen || concealed || !board) return;
    const opener = getCardOpener(board.recipeScope, pathname, search, key, routeState?.cardReturnKey);
    if (!opener) return;
    const frame = requestAnimationFrame(() => {
      (document.getElementById(cardOpenerId(opener)) ?? document.getElementById('page-heading'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorOpen, concealed, board?.recipeScope, pathname, search, key, routeState?.cardReturnKey]);

  function boardLocation(nextContext: (typeof contexts)[number]['id'], nextView?: BoardView) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('context', nextContext);
    if (nextContext !== context.id) {
      nextParams.delete('cursor');
      nextParams.delete('listIds');
    }
    if (nextView) nextParams.set('view', nextView);
    else if (nextContext !== context.id) nextParams.delete('view');
    return { pathname, search: `?${nextParams}` };
  }

  function clipboardKeys(event: KeyboardEvent<HTMLElement>) {
    if (!board || !clipboard || clipboard.busy || concealed || pending) return;
    const shortcut = clipboardShortcut(event);
    if (!shortcut) return;
    if (shortcut === 'paste') {
      if (paste.current && !paste.current.disabled) { event.preventDefault(); paste.current.click(); }
      return;
    }
    const target = event.target as HTMLElement;
    const id = target.closest<HTMLElement>('[data-clipboard-card]')?.dataset.clipboardCard;
    const card = board.cardsPage?.data.find((item) => item.id === id);
    if (card && selectClipboardCard(shortcut, card, board.recipeScope, clipboard.select)) event.preventDefault();
  }

  if (initial === null || live.phase === 'missing' || (initial && deniedBoard === initial)) return <RouteNotFound />;
  const lists = board?.lists.filter(({ kind }) => context.id === 'board' ? kind === 'active' || kind === 'closed' : kind === context.id);

  return <BoardRefreshContext.Provider value={live.recheck}>
    {concealed && <section className="page"><p role="status">{live.phase === 'checking' ? 'Checking board access…' : 'The board connection is unavailable.'}</p>
      {live.phase === 'unavailable' && <button className="workspace-button" type="button" onClick={live.recheck}>Retry</button>}
    </section>}
    <div hidden={concealed} inert={concealed}><div className="board-layout" data-inspector-open={inspectorOpen} onKeyDown={clipboardKeys}>
      <section className="page board-page" aria-labelledby="page-heading">
        <header className="page-header">
          <nav aria-label="Breadcrumb" className="workspace-breadcrumb">
            <Link to="/workspace">Projects</Link>
            {board && <Link to={projectHref(board.project.id)}>{board.project.name}</Link>}
          </nav>
          <PageHeading focus={!inspectorOpen} id="page-heading">{board?.board.name ?? 'Board'}</PageHeading>
          {!inspectorOpen && typeof routeState?.transferNotice === 'string' && <p role="status">{routeState.transferNotice}</p>}
          {board && <BoardManagement key={board.board.id} workspace={board} />}
          {board && <BoardAffiliations key={'affiliations:' + board.board.id} workspace={board} />}
          {board && <BoardFieldGroups key={'fields:' + board.board.id} workspace={board} />}
          {board && <BoardPasteControls key={board.recipeScope + '/' + board.board.id} workspace={board} trigger={paste} />}
        </header>
        <div className="board-controls">
          <nav aria-label="Board context" className="context-nav">
            {contexts.map((item) => (
              <Link aria-current={item.id === context.id ? 'page' : undefined} key={item.id} to={boardLocation(item.id)}>{item.name}</Link>
            ))}
          </nav>
          <nav aria-label="Board view" className="view-nav">
            {availableViews.map((item) => (
              <Link aria-current={item.id === view ? 'page' : undefined} key={item.id} to={boardLocation(context.id, item.id)}>{item.name}</Link>
            ))}
          </nav>
        </div>
        {board && lists ? <>
          <BoardFilters key={JSON.stringify([board.recipeScope, board.board.id, board.context, board.recipe])}
            workspace={board} lists={lists} loading={pending} onAccessLost={() => {
              refuseBoard(initial);
              live.recheck();
            }} />
          <div hidden={pending}>
            <BoardCards key={board.board.id + ':' + context.id} workspace={board} lists={lists} context={context.id} view={view} removed={live.removed} />
          </div>
        </> : !board && <EmptyState title={context.emptyTitle} />}
        {board && <ActivityFeed key={board.board.id} id={board.board.id} revision={board.latestEventSequence} removed={live.removed} />}
      </section>
      <Outlet context={{ board, liveCard: live.card } satisfies BoardInspectorContext} />
    </div></div>
  </BoardRefreshContext.Provider>;
}
