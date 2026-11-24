import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { transferredCardHref, transferNotice } from '../transfers/transfer-navigation.js';
import type { CardTransition, WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import { CardPlacementDialog, cardMoveBody, captureCardPlacement, useCardPlacementMutation, type CardPlacement, type PlacementWorkspace } from './card-placement.js';

type Card = WorkspaceReadOutput<'cardGet'>['data'];

export function CardInspectorTransitions({ card, workspace }: { card: Card; workspace: PlacementWorkspace }) {
  const action = useCardPlacementMutation();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ state: CardPlacement; mode: 'move' | 'restore' | 'duplicate' }>();
  const [message, setMessage] = useState('');
  const [restoreFocus, setRestoreFocus] = useState(false);
  const quickMove = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const state = captureCardPlacement(workspace, card);
  const copy = captureCardPlacement(workspace, card, 'duplicate');

  useEffect(() => {
    if (!action.busy && !dialog && restoreFocus) {
      (status.current ?? quickMove.current)?.focus();
      setRestoreFocus(false);
    }
  }, [action.busy, dialog, restoreFocus]);
  if (!state && !copy) return null;

  function run(operation: CardTransition | 'cards.duplicate', placement: CardPlacement, body: object) {
    const { card: { id, revision } } = placement;
    setDialog(undefined);
    setMessage('');
    void action.run([operation, id, revision, body], async (csrf, key) => {
      try {
        return await relationshipCommand(operation, csrf, key, { id, revision, body });
      } catch (error) {
        if (error instanceof WorkspaceRequestError && error.code === 'RESTORE_TARGET_REQUIRED') setDialog({ state: placement, mode: 'restore' });
        throw error;
      }
    }, async (result) => {
      if (!result) return;
      const next = result.data.card;
      const notice = operation === 'cards.archive' ? 'Card archived.' : operation === 'cards.trash' ? 'Card moved to trash.'
        : operation === 'cards.restore' ? 'Card restored.' : operation === 'cards.duplicate' ? 'Card duplicated.' : 'Card moved.';
      if (operation === 'cards.duplicate' || next.boardId !== workspace.board.id) {
        await navigate(transferredCardHref(next), { state: { transferNotice: transferNotice(notice, result.data.remaps) } });
      } else setMessage(notice);
    }).then(() => setRestoreFocus(true));
  }

  function runHistory(operation: 'cards.archive' | 'cards.trash' | 'cards.restore', placement: CardPlacement) {
    const destination = operation === 'cards.restore' ? placement.destinations.find(({ id }) => id === card.previousListId)
      : workspace.lists.find(({ kind }) => kind === (operation === 'cards.archive' ? 'archive' : 'trash'));
    run(operation, placement, { sourceOrderVersion: placement.source.orderVersion, destinationOrderVersion: destination?.orderVersion ?? null });
  }

  return <section className="card-transition-actions" aria-label="Card placement">
    <div className="project-actions">
      {state && <button className="workspace-button" type="button" ref={quickMove}
        disabled={action.busy} onClick={() => { action.clearProblem(); setDialog({ state, mode: 'move' }); }}>Move card</button>}
      {copy && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => { action.clearProblem(); setDialog({ state: copy, mode: 'duplicate' }); }}>Duplicate card</button>}
      {state && card.permissions.canArchive && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => runHistory('cards.archive', state)}>Archive card</button>}
      {state && card.permissions.canTrash && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => runHistory('cards.trash', state)}>Move to trash</button>}
      {state && card.permissions.canRestore && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => runHistory('cards.restore', state)}>Restore card</button>}
    </div>
    {message && <p tabIndex={-1} ref={status} role="status">{message}</p>}
    {action.problem && !dialog && <p tabIndex={-1} ref={status} role="alert" className="workspace-problem">{action.problem}</p>}
    {dialog && <CardPlacementDialog {...dialog} onClose={() => {
      setDialog(undefined);
      setRestoreFocus(true);
    }} onPlace={(listId, before, version) => {
      const body = cardMoveBody(dialog.state, listId, before, version);
      if (body) run(dialog.mode === 'restore' ? 'cards.restore' : dialog.mode === 'duplicate' ? 'cards.duplicate' : 'cards.move', dialog.state, body);
    }} />}
  </section>;
}
