import { useEffect, useRef, useState } from 'react';
import type { CardTransition, WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import { CardPlacementDialog, cardMoveBody, captureCardPlacement, useCardPlacementMutation, type CardPlacement, type PlacementWorkspace } from './card-placement.js';

type Card = WorkspaceReadOutput<'cardGet'>['data'];

export function CardInspectorTransitions({ card, workspace }: { card: Card; workspace: PlacementWorkspace }) {
  const action = useCardPlacementMutation();
  const [dialog, setDialog] = useState<{ state: CardPlacement; mode: 'move' | 'restore' }>();
  const [message, setMessage] = useState('');
  const [restoreFocus, setRestoreFocus] = useState(false);
  const quickMove = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const state = captureCardPlacement(workspace, card);

  useEffect(() => {
    if (!action.busy && !dialog && restoreFocus) {
      (status.current ?? quickMove.current)?.focus();
      setRestoreFocus(false);
    }
  }, [action.busy, dialog, restoreFocus]);
  if (!state) return null;

  function run(operation: CardTransition, placement: CardPlacement, body: object) {
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
    }, (result) => {
      if (result) setMessage(operation === 'cards.archive' ? 'Card archived.' : operation === 'cards.trash' ? 'Card moved to trash.'
        : operation === 'cards.restore' ? 'Card restored.' : 'Card moved.');
    }).then(() => setRestoreFocus(true));
  }

  function runHistory(operation: 'cards.archive' | 'cards.trash' | 'cards.restore', placement: CardPlacement) {
    const destination = operation === 'cards.restore' ? placement.destinations.find(({ id }) => id === card.previousListId)
      : workspace.lists.find(({ kind }) => kind === (operation === 'cards.archive' ? 'archive' : 'trash'));
    run(operation, placement, { sourceOrderVersion: placement.source.orderVersion, destinationOrderVersion: destination?.orderVersion ?? null });
  }

  return <section className="card-transition-actions" aria-label="Card placement">
    <div className="project-actions">
      {card.permissions.canMove && state.destinations.length > 0 && <button className="workspace-button" type="button" ref={quickMove}
        disabled={action.busy} onClick={() => { action.clearProblem(); setDialog({ state, mode: 'move' }); }}>Move card</button>}
      {card.permissions.canArchive && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => runHistory('cards.archive', state)}>Archive card</button>}
      {card.permissions.canTrash && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => runHistory('cards.trash', state)}>Move to trash</button>}
      {card.permissions.canRestore && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => runHistory('cards.restore', state)}>Restore card</button>}
    </div>
    {message && <p tabIndex={-1} ref={status} role="status">{message}</p>}
    {action.problem && !dialog && <p tabIndex={-1} ref={status} role="alert" className="workspace-problem">{action.problem}</p>}
    {dialog && <CardPlacementDialog {...dialog} onClose={() => {
      setDialog(undefined);
      setRestoreFocus(true);
    }} onPlace={(listId, before) => {
      const body = cardMoveBody(dialog.state, listId, before);
      if (body) run(dialog.mode === 'restore' ? 'cards.restore' : 'cards.move', dialog.state, body);
    }} />}
  </section>;
}
