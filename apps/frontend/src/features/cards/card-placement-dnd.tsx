import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDragDropMonitor, useDraggable, useDroppable } from '@dnd-kit/react';
import { relationshipCommand } from '../projects/project-api.js';
import {
  CardPlacementDialog, cardMoveBody, captureCardPlacement, useCardPlacementMutation, type CardPlacement, type PlacementCard, type PlacementWorkspace,
} from './card-placement.js';

const cardDrag = 'card-placement';
type Target = { listId: string; beforeCardId: string | null };
type Controls = {
  sourceId?: string; busy: boolean; open: (card: PlacementCard) => void; bindMoveButton: (id: string, element: HTMLButtonElement | null) => void;
};
const Placement = createContext<Controls | null>(null);

export function BoardCardPlacement({ workspace, cards, children }: { workspace: PlacementWorkspace; cards: PlacementCard[]; children: ReactNode }) {
  const action = useCardPlacementMutation();
  const gesture = useRef<CardPlacement | null>(null);
  const [sourceId, setSourceId] = useState<string>();
  const [dialog, setDialog] = useState<CardPlacement>();
  const [message, setMessage] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focus, setFocus] = useState<string>();
  const feedback = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (focus && !action.busy) {
      (buttons.current.get(focus) ?? feedback.current)?.focus();
      setFocus(undefined);
    }
  }, [focus, action.busy]);

  function place(state: CardPlacement, { listId, beforeCardId }: Target) {
    setDialog(undefined);
    const body = cardMoveBody(state, listId, beforeCardId);
    if (!body) return;
    const { card } = state;
    setMessage('');
    void action.run(['cards.move', card.id, card.revision, body], (csrf, key) =>
      relationshipCommand('cards.move', csrf, key, { id: card.id, revision: card.revision, body }),
    () => setMessage('Moved ' + card.name + '.')).then(() => setFocus(card.id));
  }

  useDragDropMonitor({
    onDragStart({ operation }) {
      if (operation.source?.type !== cardDrag) return;
      const card = cards.find(({ id }) => operation.source?.id === 'card-' + id);
      gesture.current = card ? captureCardPlacement(workspace, card) : null;
      setSourceId(gesture.current?.card.id);
    },
    onDragEnd({ canceled, operation }) {
      const state = gesture.current;
      if (!state) return;
      gesture.current = null;
      setSourceId(undefined);
      const target = operation.target?.data;
      if (canceled || typeof target?.listId !== 'string'
          || (target.beforeCardId !== null && typeof target.beforeCardId !== 'string')) {
        setFocus(state.card.id);
        return;
      }
      place(state, { listId: target.listId, beforeCardId: target.beforeCardId });
    },
  });

  return <Placement.Provider value={{ sourceId, busy: action.busy, open(card) {
    const captured = captureCardPlacement(workspace, card);
    if (captured) { action.clearProblem(); setMessage(''); setDialog(captured); }
  }, bindMoveButton(id, element) {
    if (element) buttons.current.set(id, element);
    else buttons.current.delete(id);
  } }}>
    {action.problem && <p className="workspace-problem" role="alert" ref={feedback} tabIndex={-1}>{action.problem}</p>}
    {message && <p role="status" ref={feedback} tabIndex={-1}>{message}</p>}
    {children}
    {dialog && <CardPlacementDialog state={dialog} mode="move" onClose={() => {
      setDialog(undefined);
      setFocus(dialog.card.id);
    }} onPlace={(listId, beforeCardId) => place(dialog, { listId, beforeCardId })} />}
  </Placement.Provider>;
}

export function DraggableBoardCard({ card, children }: { card: PlacementCard; children: ReactNode }) {
  const controls = useContext(Placement);
  const drag = useDraggable({ id: 'card-' + card.id, type: cardDrag, disabled: !controls || controls.busy || !card.permissions.canMove });
  const drop = useDroppable<Target>({ id: 'before-card-' + card.id, accept: cardDrag, data: { listId: card.listId, beforeCardId: card.id },
    disabled: !controls?.sourceId || controls.sourceId === card.id });
  const register = useCallback((element: HTMLLIElement | null) => {
    drag.ref(element);
    drop.ref(element);
  }, [drag.ref, drop.ref]);
  return <li ref={register} data-card-drag-source={drag.isDragging || undefined} data-card-drop-target={drop.isDropTarget || undefined}>
    {children}
    {controls && card.permissions.canMove && <div className="board-card-placement">
      <button className="workspace-button" type="button" aria-label={'Move card ' + card.name} disabled={controls.busy || !!controls.sourceId}
        ref={(element) => controls.bindMoveButton(card.id, element)} onClick={() => controls.open(card)}>Move</button>
      <span className="board-card-handle" ref={drag.handleRef} data-card-drag-handle aria-hidden="true" tabIndex={-1} title={'Drag ' + card.name}>⠿</span>
    </div>}
  </li>;
}

export function CardAppendTarget({ listId }: { listId: string }) {
  const controls = useContext(Placement);
  const drop = useDroppable<Target>({ id: 'append-card-' + listId, accept: cardDrag, data: { listId, beforeCardId: null },
    disabled: !controls?.sourceId });
  return controls?.sourceId ? <div ref={drop.ref} className="board-card-append" aria-hidden="true"
    data-card-drop-target={drop.isDropTarget || undefined}>Drop card at the end</div> : null;
}
