import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import { workspaceSignInPath, type RelationshipCommandInput, type WorkspaceReadOutput } from '@planner/contracts';
import type { BoardList } from '../lists/board-lists.js';
import { WorkspaceDialog, useWorkspaceMutation } from '../projects/project-controls.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';

export type PlacementWorkspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
export type PlacementCard = WorkspaceReadOutput<'boardCards'>['data'][number];
export type CardPlacement = { card: PlacementCard; source: BoardList; destinations: BoardList[] };

export const cardPlacementErrors = new Map([
  ['CARD_ORDER_CONFLICT', 'The card order changed. Review the current placement and try again.'],
  ['LIST_ORDER_CONFLICT', 'The list order changed. Review the current placement and try again.'],
  ['REVISION_CONFLICT', 'This card or list changed. Review the current information and try again.'],
  ['RESTORE_TARGET_REQUIRED', 'Choose an active or closed list before restoring.'],
  ['INVALID_CARD_TRANSITION', 'Choose an action available for the current card placement.'],
]);

export function useCardPlacementMutation() {
  return useWorkspaceMutation(cardPlacementErrors, 'The placement or your access changed. Review the current information and try again.',
    'Check the destination before trying again.');
}

export function captureCardPlacement(workspace: PlacementWorkspace, card: PlacementCard): CardPlacement | null {
  if (card.boardId !== workspace.board.id || !card.permissions.canMove) return null;
  const source = workspace.lists.find(({ id }) => id === card.listId);
  if (!source) return null;
  return { card, source, destinations: workspace.lists.filter(({ kind }) => kind === 'active' || kind === 'closed') };
}

export function cardMoveBody(state: CardPlacement, toListId: string, beforeCardId: string | null):
  Omit<RelationshipCommandInput<'cards.move'>, 'id' | 'expectedRevision'> | null {
  const destination = state.destinations.find(({ id }) => id === toListId);
  if (!destination) return null;
  return { toListId, beforeCardId, sourceOrderVersion: state.source.orderVersion, destinationOrderVersion: destination.orderVersion };
}

function anchorPage(boardId: string, listId: string, signal: AbortSignal, cursor?: string) {
  const query = new URLSearchParams({ context: 'board', listIds: listId, limit: '100' });
  if (cursor) query.set('cursor', cursor);
  return readWorkspace('boardCards', boardId, query, signal);
}

interface PlacementPage {
  listId: string;
  cards: PlacementCard[];
  nextCursor: string | null;
  problem?: string;
}

export function CardPlacementDialog({ state, mode, onClose, onPlace }: {
  state: CardPlacement; mode: 'move' | 'restore'; onClose: () => void; onPlace: (toListId: string, beforeCardId: string | null) => void;
}) {
  const initiallySameList = mode === 'move' && state.destinations.some(({ id }) => id === state.source.id);
  const [to, setTo] = useState(initiallySameList ? state.source.id : '');
  const [before, setBefore] = useState('');
  const [page, setPage] = useState<PlacementPage>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const requests = useRef<AbortController>(null);
  const revalidator = useRevalidator();
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const { card } = state;
  const action = mode === 'move' ? 'Move card' : 'Restore card';

  const handleProtectedRead = useCallback((error: unknown) => {
    if (!(error instanceof WorkspaceRequestError)) return false;
    if (error.status === 401) window.location.replace(signIn);
    else if (error.status === 403 || error.status === 404) setAccessLost(true);
    else return false;
    return true;
  }, [signIn]);

  useEffect(() => {
    if (accessLost) {
      onClose();
      void revalidator.revalidate();
    }
  }, [accessLost, onClose, revalidator]);

  useEffect(() => {
    setPage(undefined);
    setLoadingMore(false);
    if (!to) return;
    const controller = new AbortController();
    requests.current = controller;
    void anchorPage(card.boardId, to, controller.signal).then(({ data, page }) => {
      if (!controller.signal.aborted) setPage({ listId: to, cards: data.filter(({ id }) => id !== card.id), nextCursor: page.nextCursor });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !handleProtectedRead(error)) {
        setPage({ listId: to, cards: [], nextCursor: null, problem: 'Positions couldn’t load. You can still place the card at the end.' });
      }
    });
    return () => controller.abort();
  }, [to, card.boardId, card.id, handleProtectedRead]);

  async function loadMore() {
    const current = page?.listId === to ? page : undefined;
    const controller = requests.current;
    if (!current?.nextCursor || !controller || controller.signal.aborted || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await anchorPage(card.boardId, to, controller.signal, current.nextCursor);
      if (controller.signal.aborted) return;
      const cards = new Map(current.cards.map((candidate) => [candidate.id, candidate]));
      for (const candidate of next.data) if (candidate.id !== card.id) cards.set(candidate.id, candidate);
      setPage({ listId: to, cards: [...cards.values()], nextCursor: next.page.nextCursor });
    } catch (error) {
      if (!controller.signal.aborted && !handleProtectedRead(error)) setPage({ ...current, problem: 'More positions couldn’t load.' });
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (to) onPlace(to, before || null);
  }

  return <WorkspaceDialog title={action} onClose={onClose}>
    <form className="project-form" method="post" onSubmit={submit}>
      {mode === 'restore' && <p>Choose an active or closed list before restoring.</p>}
      <label>Destination list<select value={to} required ref={(element) => { if (element) element.autofocus = true; }}
        onChange={(event) => { setTo(event.target.value); setBefore(''); }}>
        <option value="" disabled>Choose a list</option>
        {state.destinations.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
      </select></label>
      {to && <label>Position<select value={before} onChange={(event) => setBefore(event.target.value)}>
        <option value="">At the end</option>
        {page?.listId === to && page.cards.map(({ id, name }) => <option key={id} value={id}>Before {name}</option>)}
      </select></label>}
      {to && page?.listId === to && page.nextCursor && <button className="workspace-button" type="button" disabled={loadingMore}
        onClick={() => void loadMore()}>{loadingMore ? 'Loading positions…' : 'Load more positions'}</button>}
      {to && page?.listId === to && page.problem && <p role="status">{page.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!to}>{action}</button>
    </form>
  </WorkspaceDialog>;
}
