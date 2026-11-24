import { useState, type FormEvent } from 'react';
import { listColorSchema, type ListColor } from '@planner/contracts';
import { useRevalidator } from 'react-router';
import { TransferBoardPicker, type TransferBoard } from '../transfers/transfer-board-picker.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import type { BoardList } from './board-lists.js';

export const listColorNames: Record<ListColor, string> = {
  'berry-red': 'Berry red', 'pumpkin-orange': 'Pumpkin orange', 'lagoon-blue': 'Lagoon blue', 'pink-tulip': 'Pink tulip',
  'light-mud': 'Light mud', 'orange-peel': 'Orange peel', 'bright-moss': 'Bright moss', 'antique-blue': 'Antique blue',
  'dark-granite': 'Dark granite', 'turquoise-sea': 'Turquoise sea',
};

function dialogAutofocus(element: HTMLElement | null) {
  if (element) element.autofocus = true;
}

type ListDetails = { name?: string; color?: ListColor | null; kind?: 'active' | 'closed' };

export function ListDetailsDialog({ list, busy, problem, close, save }: {
  list?: BoardList; busy: boolean; problem: string; close: () => void; save: (details: ListDetails) => void;
}) {
  const [name, setName] = useState<string>();
  const [color, setColor] = useState<ListColor | null>();
  const [kind, setKind] = useState<'active' | 'closed'>('active');
  const currentName = name ?? list?.name ?? '';
  const currentColor = color === undefined ? list?.color ?? null : color;
  const rename = name !== undefined && name.trim() !== list?.name;
  const recolor = color !== undefined && color !== list?.color;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!currentName.trim() || (rename && !name?.trim())) return;
    if (list) {
      if (rename || recolor) save({ ...(rename && { name: name!.trim() }), ...(recolor && { color }) });
    } else save({ name: currentName.trim(), color: currentColor, kind });
  }

  return <WorkspaceDialog title={list ? 'Edit list' : 'Create list'} busy={busy} onClose={close}>
    <form className="project-form" method="post" onSubmit={submit}>
      <label>List name<input value={currentName} maxLength={128} required ref={dialogAutofocus} onChange={(event) => setName(event.target.value)} /></label>
      {!list && <label>List type<select value={kind} onChange={(event) => setKind(event.target.value === 'closed' ? 'closed' : 'active')}>
        <option value="active">Active</option><option value="closed">Closed</option>
      </select></label>}
      <label>List color<select value={currentColor ?? ''} onChange={(event) => setColor(listColorSchema.safeParse(event.target.value).data ?? null)}>
        <option value="">None</option>
        {listColorSchema.options.map((value) => <option key={value} value={value}>{listColorNames[value]}</option>)}
      </select></label>
      {problem && <p className="workspace-problem" role="alert">{problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit"
        disabled={busy || !currentName.trim() || (!!list && !rename && !recolor)}>{list ? 'Save list' : 'Create list'}</button>
    </form>
  </WorkspaceDialog>;
}

export function MoveListDialog({ boardId, list, neighbors, previousAnchor, onMove, onClose }: {
  boardId: string; list: Pick<BoardList, 'name'>; neighbors: Pick<BoardList, 'id' | 'name'>[]; previousAnchor: string | null;
  onMove: (beforeId: string | null, destination?: TransferBoard) => void; onClose: () => void;
}) {
  const revalidator = useRevalidator();
  const [before, setBefore] = useState(previousAnchor ?? '');
  const [destination, setDestination] = useState<TransferBoard | null | undefined>(null);
  const choices = destination ? destination.lists.filter(({ kind }) => kind === 'active' || kind === 'closed') : neighbors;
  const canMove = destination !== undefined && (destination !== null || before !== (previousAnchor ?? ''));
  return <WorkspaceDialog title="Move list" onClose={onClose}>
    <form className="project-form" method="post" onSubmit={(event) => {
      event.preventDefault();
      if (canMove) onMove(before || null, destination ?? undefined);
    }}>
      <p>Move <strong>{list.name}</strong> with its cards.</p>
      <TransferBoardPicker sourceBoardId={boardId} onPick={(next) => {
        setDestination(next);
        setBefore(next === null ? previousAnchor ?? '' : '');
      }} onUnavailable={() => { onClose(); void revalidator.revalidate(); }} />
      <label>Place list<select value={before} ref={dialogAutofocus} disabled={destination === undefined} onChange={(event) => setBefore(event.target.value)}>
        {choices.map(({ id, name }) => <option value={id} key={id}>Before {name}</option>)}
        <option value="">At the end</option>
      </select></label>
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!canMove}>Move list</button>
    </form>
  </WorkspaceDialog>;
}
