import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
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

export function CardPlacementDialog({ state, mode, onClose, onPlace }: {
  state: CardPlacement; mode: 'move' | 'restore'; onClose: () => void; onPlace: (toListId: string, beforeCardId: string | null) => void;
}) {
  const initiallySameList = mode === 'move' && state.destinations.some(({ id }) => id === state.source.id);
  const [to, setTo] = useState(initiallySameList ? state.source.id : '');
  const [before, setBefore] = useState('');
  const [page, setPage] = useState<{ listId: string; cards: PlacementCard[]; failed?: boolean }>();
  const { pathname, search } = useLocation();
  const signIn = workspaceSignInPath(pathname + search);
  const { card } = state;
  const action = mode === 'move' ? 'Move card' : 'Restore card';

  useEffect(() => {
    if (!to) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ context: 'board', listIds: to, limit: '100' });
    void readWorkspace('boardCards', card.boardId, query, controller.signal).then(({ data }) => {
      if (!controller.signal.aborted) setPage({ listId: to, cards: data.filter(({ id }) => id !== card.id) });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(signIn);
      else setPage({ listId: to, cards: [], failed: true });
    });
    return () => controller.abort();
  }, [to, card.boardId, card.id, signIn]);

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
      {to && page?.listId === to && page.failed && <p role="status">Positions couldn’t load. You can still place the card at the end.</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!to}>{action}</button>
    </form>
  </WorkspaceDialog>;
}
