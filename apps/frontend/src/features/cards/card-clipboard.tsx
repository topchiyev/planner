import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useLocation, useNavigate, useRouteLoaderData } from 'react-router';
import { workspaceSignInPath, type WorkspaceReadOutput } from '@planner/contracts';
import type { loadBrowserSession } from '../auth/browser-session.js';
import { useBoardRefresh } from '../boards/board-refresh.js';
import { relationshipCommand } from '../projects/project-api.js';
import { transferredCardHref, transferNotice } from '../transfers/transfer-navigation.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import { useBoardClipboard, type ClipboardAction, type ClipboardSelection, type PasteAttempt } from './card-clipboard-state.js';
import { CardPlacementDialog, cardMoveBody, type CardPlacement, type PlacementCard, type PlacementWorkspace } from './card-placement.js';

export function clipboardShortcut(event: KeyboardEvent<HTMLElement>) {
  const { target } = event;
  if (event.defaultPrevented || event.repeat || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey
      || event.nativeEvent.isComposing || !(target instanceof HTMLElement)
      || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog[open]')) return null;
  const key = event.key.toLowerCase();
  if (key === 'v') return 'paste';
  if (window.getSelection()?.isCollapsed === false) return null;
  return key === 'x' ? 'cut' : key === 'c' ? 'copy' : null;
}

export function selectClipboardCard(action: ClipboardAction, card: PlacementCard, scope: string,
  select: NonNullable<ReturnType<typeof useBoardClipboard>>['select']) {
  if (!(action === 'cut' ? card.permissions.canMove : card.permissions.canDuplicateFrom)) return false;
  select(action, scope, card);
  return true;
}

export function CardClipboardActions({ card, scope }: { card: PlacementCard; scope: string }) {
  const clipboard = useBoardClipboard();
  if (!clipboard || (!card.permissions.canMove && !card.permissions.canDuplicateFrom)) return null;
  return <section className="project-actions" aria-label="Card clipboard">
    {card.permissions.canMove && <button className="workspace-button" type="button" disabled={clipboard.busy}
      onClick={() => clipboard.select('cut', scope, card)}>Cut card</button>}
    {card.permissions.canDuplicateFrom && <button className="workspace-button" type="button" disabled={clipboard.busy}
      onClick={() => clipboard.select('copy', scope, card)}>Copy card</button>}
  </section>;
}

type SourceSnapshot = { card: PlacementCard; source: CardPlacement['source']; board: WorkspaceReadOutput<'boardWorkspace'>['data'] };

async function sourceSnapshot(selected: ClipboardSelection, signal?: AbortSignal): Promise<SourceSnapshot | null> {
  const [cardResult, boardResult] = await Promise.all([
    readWorkspace('cardGet', selected.cardId, new URLSearchParams({ boardId: selected.boardId }), signal),
    readWorkspace('boardWorkspace', selected.boardId, undefined, signal),
  ]);
  const card = cardResult.data;
  const board = boardResult.data;
  const source = board.lists.find(({ id }) => id === card.listId);
  if (!source || card.boardId !== selected.boardId || card.revision !== selected.revision || board.recipeScope !== selected.scope
      || !(selected.action === 'cut' ? card.permissions.canMove : card.permissions.canDuplicateFrom)) return null;
  return { card, board, source };
}

function missing(error: unknown) {
  return error instanceof WorkspaceRequestError && (error.status === 403 || error.status === 404);
}

export function BoardPasteControls({ workspace, trigger }: { workspace: PlacementWorkspace; trigger: Ref<HTMLButtonElement> }) {
  const clipboard = useBoardClipboard();
  const session = useRouteLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>('app-shell');
  const navigate = useNavigate();
  const refresh = useBoardRefresh();
  const { pathname, search } = useLocation();
  const [picker, setPicker] = useState<{ selected: ClipboardSelection; state: CardPlacement }>();
  const [problem, setProblem] = useState('');
  const [checking, setChecking] = useState(false);
  const preflight = useRef<AbortController>(null);
  const mounted = useRef(false);
  const selected = clipboard?.selected?.scope === workspace.recipeScope ? clipboard.selected : undefined;
  const attempt = clipboard?.attempt?.selected === selected ? clipboard?.attempt : undefined;
  const canPaste = workspace.board.permissions.canEdit;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; preflight.current?.abort(); };
  }, []);
  useEffect(() => {
    setChecking(false);
    return () => preflight.current?.abort();
  }, [selected]);

  useEffect(() => { if (!canPaste) setPicker(undefined); }, [canPaste]);

  function signIn(error: unknown) {
    if (!(error instanceof WorkspaceRequestError) || error.status !== 401) return false;
    window.location.replace(workspaceSignInPath(pathname + search));
    return true;
  }
  function changedSource(current: ClipboardSelection) {
    clipboard?.discard(current);
    if (mounted.current) setProblem('The source card changed or is no longer available. Select it again before pasting.');
  }

  async function openPaste() {
    if (!selected || !canPaste || checking || attempt || clipboard?.busy) return;
    const controller = new AbortController();
    preflight.current?.abort();
    preflight.current = controller;
    const { signal } = controller;
    setProblem('');
    setChecking(true);
    try {
      let snapshot: SourceSnapshot | null;
      try { snapshot = await sourceSnapshot(selected, signal); }
      catch (error) {
        if (!signal.aborted && !signIn(error)) {
          if (missing(error)) changedSource(selected);
          else setProblem('The source card could not be checked. Try pasting again.');
        }
        return;
      }
      if (signal.aborted) return;
      if (!snapshot) { changedSource(selected); return; }
      const target = selected.boardId === workspace.board.id ? snapshot.board
        : (await readWorkspace('boardWorkspace', workspace.board.id, undefined, signal)).data;
      if (signal.aborted) return;
      const destinations = target.lists.filter(({ kind }) => kind === 'active' || kind === 'closed');
      if (!target.board.permissions.canEdit || target.recipeScope !== selected.scope || !destinations.length) {
        setProblem('Choose a board you can edit with an active or closed list.');
        refresh();
        return;
      }
      setPicker({ selected, state: { card: snapshot.card, source: snapshot.source, destinations } });
    } catch (error) {
      if (!signal.aborted && !signIn(error)) {
        setProblem('The destination could not be checked. Update the board and choose a destination again.');
        refresh();
      }
    } finally { if (!signal.aborted) setChecking(false); }
  }

  async function sendPaste(paste: PasteAttempt) {
    if (!clipboard || !session || !clipboard.begin(paste)) return;
    const { selected: source, body, key } = paste;
    setPicker(undefined);
    setProblem('');
    try {
      const result = await relationshipCommand(source.action === 'cut' ? 'cards.move' : 'cards.duplicate', session.csrfToken, key,
        { id: source.cardId, revision: source.revision, body });
      if (!result) throw new Error('Missing paste receipt');
      if (clipboard.settle(paste, 'committed') && mounted.current) {
        const notice = source.action === 'cut' ? 'Card pasted and moved.' : 'Card pasted as a copy.';
        await navigate(transferredCardHref(result.data.card), { state: { transferNotice: transferNotice(notice, result.data.remaps) } });
      }
    } catch (error) {
      if (signIn(error)) return;
      if (!(error instanceof WorkspaceRequestError) || ![403, 404, 409, 422].includes(error.status)) {
        clipboard.settle(paste, 'uncertain');
        return;
      }
      if (!clipboard.settle(paste, 'declined')) return;
      if (mounted.current) setProblem('The placement changed or was refused. Choose a current destination and try again.');
      try { if (!await sourceSnapshot(source)) changedSource(source); }
      catch (sourceError) { if (!signIn(sourceError) && missing(sourceError)) changedSource(source); }
      if (mounted.current) refresh();
    }
  }

  if (!clipboard || (!selected && !problem)) return null;
  return <section className="board-clipboard" aria-label="Board clipboard">
    {selected && <div className="project-actions">
      <span role="status">{selected.action === 'cut' ? 'Card cut. Choose where to move it.' : 'Card copied. Choose where to duplicate it.'}</span>
      {(canPaste || attempt) && <button ref={trigger} className="workspace-button" type="button"
        disabled={clipboard.busy || checking} onClick={() => attempt ? void sendPaste(attempt) : void openPaste()}>
        {attempt && !clipboard.busy ? 'Retry paste' : 'Paste card'}
      </button>}
      <button className="workspace-button" type="button" disabled={clipboard.busy} onClick={() => { clipboard.discard(selected); setProblem(''); }}>Clear clipboard</button>
    </div>}
    {(checking || clipboard.busy) && <p role="status">{checking ? 'Checking card placement…' : 'Pasting card…'}</p>}
    {attempt && !clipboard.busy && <p className="workspace-problem" role="alert">The paste response was interrupted. Retry to confirm the same paste.</p>}
    {problem && <p className="workspace-problem" role="alert">{problem}</p>}
    {canPaste && picker && picker.selected === selected && <CardPlacementDialog state={picker.state}
      mode={picker.selected.action === 'cut' ? 'move' : 'duplicate'} destination={workspace.board.id} title="Paste card"
      onClose={() => setPicker(undefined)} onPlace={(list, before, version, board) => {
        const body = cardMoveBody(picker.state, list, before, version, board);
        if (body && !attempt) void sendPaste({ selected: picker.selected, body, key: crypto.randomUUID() });
      }} />}
  </section>;
}
