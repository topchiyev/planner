import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DragDropProvider, PointerSensor, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/react';
import type { RelationshipCommandInput } from '@planner/contracts';
import { EmptyState } from '../../app/page-state.js';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import { ListDetailsDialog, MoveListDialog, listColorNames } from './list-dialogs.js';
import './board-lists.css';

type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
export type BoardList = Workspace['lists'][number];
type MoveSnapshot = {
  boardId: string; list: BoardList; orderVersion: number; neighbors: BoardList[]; previousAnchor: string | null;
};

const appendTarget = 'list-end';
const listDrag = 'list-placement';
const pointerSensors = [PointerSensor];
const listErrors = new Map([
  ['LIST_ORDER_CONFLICT', 'The list order changed. Review the current order and try again.'],
  ['REVISION_CONFLICT', 'The board or list changed. Review the current information and try again.'],
  ['INVALID_LIST_ANCHOR', 'Choose a different list as the destination.'],
]);

function ListSummary({ list }: { list: BoardList }) {
  const kind = { active: 'Active', closed: 'Closed', archive: 'Archive', trash: 'Trash' }[list.kind];
  return <div className="board-list-summary">
    <strong>{list.name}</strong>
    <div className="board-list-info">
      {list.color && <span className="board-list-swatch" data-color={list.color} title={listColorNames[list.color]} aria-label={listColorNames[list.color]} role="img" />}
      <span>{kind}</span><span>{list.cardCount} {list.cardCount === 1 ? 'card' : 'cards'}</span>
    </div>
  </div>;
}

export function ReadonlyBoardLists({ lists, renderContents }: {
  lists: BoardList[]; renderContents?: (list: BoardList) => ReactNode;
}) {
  return lists.length ? <ul aria-label="Board lists" className="workspace-list-summary">
    {lists.map((list) => <li key={list.id}><ListSummary list={list} />{renderContents?.(list)}</li>)}
  </ul> : <EmptyState title="No lists to show" />;
}

function EditableList({ list, busy, allowMove, dragging, edit, move, focus, children }: {
  list: BoardList; busy: boolean; allowMove: boolean; dragging?: string;
  edit: () => void; move: () => void; focus: (node: HTMLButtonElement | null) => void; children?: ReactNode;
}) {
  const drag = useDraggable({ id: list.id, type: listDrag, disabled: busy || !allowMove });
  const drop = useDroppable({ id: 'before-' + list.id, accept: listDrag, disabled: !dragging || dragging === list.id });
  const register = useCallback((node: HTMLLIElement | null) => {
    drag.ref(node);
    drop.ref(node);
  }, [drag.ref, drop.ref]);
  return <li ref={register}
    data-list-drag-source={drag.isDragging || undefined} data-list-drop-target={drop.isDropTarget || undefined}>
    <ListSummary list={list} />
    <div className="project-actions">
      <button type="button" className="workspace-button" aria-label={'Edit ' + list.name} disabled={busy || !!dragging} onClick={edit}>Edit</button>
      {allowMove && <>
        <button type="button" className="workspace-button" aria-label={'Move ' + list.name} disabled={busy || !!dragging} ref={focus} onClick={move}>Move</button>
        <span ref={drag.handleRef} className="board-list-handle" data-list-drag-handle tabIndex={-1}
          aria-hidden="true" title={'Drag ' + list.name}>⠿</span>
      </>}
    </div>
    {children}
  </li>;
}

function AppendTarget({ active }: { active: boolean }) {
  const end = useDroppable({ id: appendTarget, accept: listDrag, disabled: !active });
  return active ? <div className="board-list-append" aria-hidden="true" ref={end.ref}
    data-list-drop-target={end.isDropTarget || undefined}>Drop at the end</div> : null;
}

type Dialog = { kind: 'create' } | { kind: 'edit'; listId: string } | { kind: 'move'; snapshot: MoveSnapshot };

export function BoardLists({ workspace, lists, renderContents, wrapDragContents }: {
  workspace: Workspace; lists: BoardList[]; renderContents?: (list: BoardList) => ReactNode;
  wrapDragContents?: (content: ReactNode) => ReactNode;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState<string>();
  const gesture = useRef<MoveSnapshot | null>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const [restoreFocus, setRestoreFocus] = useState<string>();
  const createButton = useRef<HTMLButtonElement>(null);
  const action = useWorkspaceMutation(listErrors, 'The board or your access changed. Review the current information and try again.',
    'Enter a list name and choose a supported color.');

  useEffect(() => {
    if (restoreFocus && !action.busy) {
      (moveButtons.current.get(restoreFocus) ?? createButton.current)?.focus();
      setRestoreFocus(undefined);
    }
  }, [action.busy, restoreFocus]);
  const close = () => setDialog(null);

  function snapshot(id: string): MoveSnapshot | null {
    const index = lists.findIndex((list) => list.id === id);
    if (index < 0 || lists.length < 2) return null;
    return {
      boardId: workspace.board.id, list: lists[index], orderVersion: workspace.orderVersion,
      neighbors: lists.filter((list) => list.id !== id), previousAnchor: lists[index + 1]?.id ?? null,
    };
  }

  function runMove(state: MoveSnapshot, beforeListId: string | null) {
    close();
    if (beforeListId === state.previousAnchor) {
      setRestoreFocus(state.list.id);
      return;
    }
    const { boardId, orderVersion, list } = state;
    const body: Omit<RelationshipCommandInput<'lists.move'>, 'id' | 'expectedRevision'> = {
      toBoardId: boardId, beforeListId, sourceOrderVersion: orderVersion, destinationOrderVersion: orderVersion,
    };
    setMessage('');
    void action.run(['lists.move', list.id, list.revision, body], (csrf, key) =>
      relationshipCommand('lists.move', csrf, key, { id: list.id, revision: list.revision, body }),
    () => setMessage('Moved ' + list.name + '.')).then(() => setRestoreFocus(list.id));
  }

  function dragStart({ operation }: DragStartEvent) {
    if (operation.source?.type !== listDrag) return;
    gesture.current = typeof operation.source?.id === 'string' ? snapshot(operation.source.id) : null;
    setDragging(gesture.current?.list.id);
  }

  function dragEnd({ canceled, operation }: DragEndEvent) {
    const state = gesture.current;
    gesture.current = null;
    setDragging(undefined);
    if (!state) return;
    const target = canceled ? null : operation.target?.id;
    if (target === appendTarget) runMove(state, null);
    else {
      const anchor = state.neighbors.find(({ id }) => target === 'before-' + id);
      if (anchor) runMove(state, anchor.id);
      else setRestoreFocus(state.list.id);
    }
  }

  const edit = dialog?.kind === 'edit' ? lists.find(({ id }) => id === dialog.listId) : undefined;
  const details = dialog?.kind === 'create' || edit;
  const dragContents = <>
    <ul className="workspace-list-summary board-editable-lists" aria-label="Board lists">
      {lists.map((list) => <EditableList key={list.id} list={list} busy={action.busy} dragging={dragging}
        allowMove={lists.length > 1} edit={() => {
          action.clearProblem(); setMessage(''); setDialog({ kind: 'edit', listId: list.id });
        }} move={() => {
          const captured = snapshot(list.id);
          if (captured) { action.clearProblem(); setMessage(''); setDialog({ kind: 'move', snapshot: captured }); }
        }} focus={(node) => { if (node) moveButtons.current.set(list.id, node); else moveButtons.current.delete(list.id); }}>{renderContents?.(list)}</EditableList>)}
    </ul>
    <AppendTarget active={!!dragging} />
  </>;
  return <section className="board-lists" aria-label="Lists">
    <div className="board-list-controls">
      <button className="workspace-button workspace-button-primary" type="button" ref={createButton} disabled={action.busy || !!dragging}
        onClick={() => { action.clearProblem(); setMessage(''); setDialog({ kind: 'create' }); }}>Add list</button>
    </div>
    {message && <p role="status">{message}</p>}
    {action.problem && !details && <p role="alert" className="workspace-problem">{action.problem}</p>}
    {lists.length > 0 ? <DragDropProvider sensors={pointerSensors} onDragStart={dragStart} onDragEnd={dragEnd}>
      {wrapDragContents ? wrapDragContents(dragContents) : dragContents}
    </DragDropProvider> : <EmptyState title="No lists to show" />}
    {details && <ListDetailsDialog list={edit} busy={action.busy} problem={action.problem} close={close} save={(body) => {
      const command = edit ? 'lists.update' : 'lists.create';
      const { id, revision } = edit ?? workspace.board;
      void action.run([command, id, revision, body], (csrf, key) =>
        relationshipCommand(command, csrf, key, { id, revision, body }), () => {
          close();
          setMessage(edit ? 'List updated.' : 'List created.');
        });
    }} />}
    {dialog?.kind === 'move' && <MoveListDialog {...dialog.snapshot} onClose={() => {
      close();
      setRestoreFocus(dialog.snapshot.list.id);
    }} onMove={(anchor) => runMove(dialog.snapshot, anchor)} />}
  </section>;
}
