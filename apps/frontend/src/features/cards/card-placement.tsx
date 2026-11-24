import { useBoardRefresh } from '../boards/board-refresh.js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { workspaceSignInPath, type RelationshipCommandInput, type WorkspaceReadOutput } from '@planner/contracts';
import { TransferBoardPicker, type TransferBoard } from '../transfers/transfer-board-picker.js';
import type { BoardList } from '../lists/board-lists.js';
import { WorkspaceDialog, useWorkspaceMutation } from '../projects/project-controls.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';

export type PlacementWorkspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
export type PlacementCard = Pick<WorkspaceReadOutput<'boardCards'>['data'][number],
  'id' | 'name' | 'revision' | 'boardId' | 'listId' | 'kind' | 'permissions'>;
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

export function captureCardPlacement(workspace: PlacementWorkspace, card: PlacementCard, mode: 'move' | 'duplicate' = 'move'): CardPlacement | null {
  if (card.boardId !== workspace.board.id || !(mode === 'move' ? card.permissions.canMove : card.permissions.canDuplicateFrom)) return null;
  const source = workspace.lists.find(({ id }) => id === card.listId);
  if (!source) return null;
  return { card, source, destinations: workspace.board.permissions.canEdit ? workspace.lists.filter(({ kind }) => kind === 'active' || kind === 'closed') : [] };
}

export function cardMoveBody(state: CardPlacement, toListId: string, beforeCardId: string | null, destinationVersion?: number, destinationBoardId?: string):
  Omit<RelationshipCommandInput<'cards.move'>, 'id' | 'expectedRevision'> | null {
  const destination = state.destinations.find(({ id }) => id === toListId);
  const destinationOrderVersion = destinationVersion ?? destination?.orderVersion;
  if (destinationOrderVersion === undefined) return null;
  return { toListId, beforeCardId, sourceOrderVersion: state.source.orderVersion, destinationOrderVersion, ...(destinationBoardId && { destinationBoardId }) };
}

export function anchorPage(boardId: string, listId: string, signal: AbortSignal, cursor?: string) {
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
  state: CardPlacement; mode: 'move' | 'restore' | 'duplicate'; onClose: () => void;
  onPlace: (toListId: string, beforeCardId: string | null, destinationVersion: number, destinationBoardId: string) => void;
}) {
  const initiallySameList = mode !== 'restore' && state.destinations.some(({ id }) => id === state.source.id);
  const [to, setTo] = useState(initiallySameList ? state.source.id : '');
  const [before, setBefore] = useState('');
  const [destinationBoard, setDestinationBoard] = useState<TransferBoard | null | undefined>(null);
  const [page, setPage] = useState<PlacementPage>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const requests = useRef<AbortController>(null);
  const refresh = useBoardRefresh();
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const { card } = state;
  const action = mode === 'move' ? 'Move card' : mode === 'duplicate' ? 'Duplicate card' : 'Restore card';
  const boardId = destinationBoard?.id ?? card.boardId;
  const destinations = destinationBoard === undefined ? [] : destinationBoard
    ? destinationBoard.lists.filter(({ kind }) => kind === 'active' || kind === 'closed') : state.destinations;
  const destinationVersion = destinations.find(({ id }) => id === to)?.orderVersion;

  function pickBoard(destination: TransferBoard | null | undefined) {
    setDestinationBoard(destination);
    setTo('');
    setBefore('');
  }

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
      refresh();
    }
  }, [accessLost, onClose, refresh]);

  useEffect(() => {
    setPage(undefined);
    setLoadingMore(false);
    if (!to) return;
    const controller = new AbortController();
    requests.current = controller;
    void anchorPage(boardId, to, controller.signal).then(({ data, page }) => {
      if (!controller.signal.aborted) setPage({ listId: to, cards: data.filter(({ id }) => mode === 'duplicate' || id !== card.id), nextCursor: page.nextCursor });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !handleProtectedRead(error)) {
        setPage({ listId: to, cards: [], nextCursor: null, problem: 'Positions couldn’t load. You can still place the card at the end.' });
      }
    });
    return () => controller.abort();
  }, [to, boardId, card.id, mode, handleProtectedRead]);

  async function loadMore() {
    const current = page?.listId === to ? page : undefined;
    const controller = requests.current;
    if (!current?.nextCursor || !controller || controller.signal.aborted || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await anchorPage(boardId, to, controller.signal, current.nextCursor);
      if (controller.signal.aborted) return;
      const cards = new Map(current.cards.map((candidate) => [candidate.id, candidate]));
      for (const candidate of next.data) if (mode === 'duplicate' || candidate.id !== card.id) cards.set(candidate.id, candidate);
      setPage({ listId: to, cards: [...cards.values()], nextCursor: next.page.nextCursor });
    } catch (error) {
      if (!controller.signal.aborted && !handleProtectedRead(error)) setPage({ ...current, problem: 'More positions couldn’t load.' });
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (to && destinationVersion !== undefined) onPlace(to, before || null, destinationVersion, boardId);
  }

  return <WorkspaceDialog title={action} onClose={onClose}>
    <form className="project-form" method="post" onSubmit={submit}>
      {mode === 'restore' && <p>Choose an active or closed list before restoring.</p>}
      {mode !== 'restore' && <TransferBoardPicker sourceBoardId={card.boardId} onPick={pickBoard} onUnavailable={() => setAccessLost(true)} />}
      <label>Destination list<select value={to} required disabled={!destinations.length} ref={(element) => { if (element) element.autofocus = true; }}
        onChange={(event) => { setTo(event.target.value); setBefore(''); }}>
        <option value="" disabled>Choose a list</option>
        {destinations.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
      </select></label>
      {to && <label>Position<select value={before} onChange={(event) => setBefore(event.target.value)}>
        <option value="">At the end</option>
        {page?.listId === to && page.cards.map(({ id, name }) => <option key={id} value={id}>Before {name}</option>)}
      </select></label>}
      {to && page?.listId === to && page.nextCursor && <button className="workspace-button" type="button" disabled={loadingMore}
        onClick={() => void loadMore()}>{loadingMore ? 'Loading positions…' : 'Load more positions'}</button>}
      {to && page?.listId === to && page.problem && <p role="status">{page.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!to || destinationVersion === undefined}>{action}</button>
    </form>
  </WorkspaceDialog>;
}
