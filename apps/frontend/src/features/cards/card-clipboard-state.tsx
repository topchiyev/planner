import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { RelationshipCommandInput } from '@planner/contracts';
import type { PlacementCard } from './card-placement.js';

export type ClipboardAction = 'cut' | 'copy';
export type ClipboardSelection = Readonly<{
  action: ClipboardAction; scope: string; cardId: string; boardId: string; revision: number;
}>;

type PasteBody = Omit<RelationshipCommandInput<'cards.move'>, 'id' | 'expectedRevision'>;
export type PasteAttempt = Readonly<{ selected: ClipboardSelection; key: string; body: Readonly<PasteBody> }>;
type ClipboardState = { selected?: ClipboardSelection; attempt?: PasteAttempt; busy: boolean };

type BoardClipboard = ClipboardState & {
  select: (action: ClipboardAction, scope: string, card: PlacementCard) => void;
  discard: (expected: ClipboardSelection) => void;
  begin: (attempt: PasteAttempt) => boolean;
  settle: (attempt: PasteAttempt, outcome: 'committed' | 'declined' | 'uncertain') => boolean;
};

const BoardClipboardContext = createContext<BoardClipboard | null>(null);

export function BoardClipboardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ClipboardState>({ busy: false });
  const current = useRef(state);
  function update(next: ClipboardState) {
    current.current = next;
    setState(next);
  }
  return <BoardClipboardContext.Provider value={{
    ...state,
    select(action, scope, card) {
      if (current.current.busy || !(action === 'cut' ? card.permissions.canMove : card.permissions.canDuplicateFrom)) return;
      update({ selected: { action, scope, cardId: card.id, boardId: card.boardId, revision: card.revision }, busy: false });
    },
    discard(expected) {
      if (current.current.selected === expected) update({ busy: false });
    },
    begin(attempt) {
      if (current.current.busy || current.current.selected !== attempt.selected ||
          (current.current.attempt && current.current.attempt !== attempt)) return false;
      update({ selected: attempt.selected, attempt, busy: true });
      return true;
    },
    settle(attempt, outcome) {
      if (current.current.attempt !== attempt) return false;
      const selected = outcome === 'committed' && attempt.selected.action === 'cut' ? undefined : attempt.selected;
      update({ selected, attempt: outcome === 'uncertain' ? attempt : undefined, busy: false });
      return true;
    },
  }}>{children}</BoardClipboardContext.Provider>;
}

export function useBoardClipboard() {
  return useContext(BoardClipboardContext);
}
