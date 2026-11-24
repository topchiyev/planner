import { useState, type FormEvent } from 'react';
import { type RelationshipCommandInput, type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog, useWorkspaceMutation } from '../projects/project-controls.js';
import type { Checklist } from './checklist-display.js';

export type ChecklistCard = WorkspaceReadOutput<'cardGet'>['data'];
export type Close = () => void;

const errors = new Map([
  ['CHECKLIST_ORDER_CONFLICT', 'The checklist order changed. Review it and try again.'],
  ['INELIGIBLE_ACCOUNT', 'Choose an active member of this board.'],
  ['TASK_FIELDS_UNAVAILABLE', 'This task does not support editing those fields.'],
]);

export function useChecklistMutation() {
  return useWorkspaceMutation(errors, 'The checklist or your access changed. Review the current information and try again.');
}

export function ChecklistForm({ card, group, groups, close }: {
  card: ChecklistCard; group?: Checklist; groups: Checklist[]; close: Close;
}) {
  const action = useChecklistMutation();
  const [name, setName] = useState(group?.name ?? '');
  const [front, setFront] = useState(group?.showOnFront ?? true);
  const [hide, setHide] = useState(group?.hideCompleted ?? false);
  const [before, setBefore] = useState('');
  const valid = !!name.trim() && (name === group?.name || name.trim().length <= 128);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    if (group) {
      const body: Omit<RelationshipCommandInput<'checklists.update'>, 'id' | 'expectedRevision'> = {
        ...(name.trim() !== group.name && name !== group.name && { name: name.trim() }),
        ...(front !== group.showOnFront && { showOnFront: front }),
        ...(hide !== group.hideCompleted && { hideCompleted: hide }),
      };
      if (!Object.keys(body).length) { close(); return; }
      void action.run(['checklists.update', group.id, group.revision, body], (csrf, key) =>
        relationshipCommand('checklists.update', csrf, key, { id: group.id, revision: group.revision, body }), close);
    } else {
      const body = { name: name.trim(), showOnFront: front, hideCompleted: hide, beforeChecklistId: before || null };
      void action.run(['checklists.create', card.id, card.revision, body], (csrf, key) =>
        relationshipCommand('checklists.create', csrf, key, { id: card.id, revision: card.revision, body }), close);
    }
  }

  return <WorkspaceDialog title={group ? 'Checklist settings' : 'Add checklist'} onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={save}>
      <label>Checklist name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus required
        maxLength={Math.max(128, group?.name.length ?? 0)} /></label>
      <label className="board-checkbox"><input type="checkbox" checked={front}
        onChange={(event) => setFront(event.target.checked)} />Show on card front</label>
      <label className="board-checkbox"><input type="checkbox" checked={hide}
        onChange={(event) => setHide(event.target.checked)} />Hide completed tasks</label>
      {!group && groups.length > 0 && <label>Checklist position<select value={before} onChange={(event) => setBefore(event.target.value)}>
        <option value="">At the end</option>
        {groups.map(({ id, name }) => <option key={id} value={id}>Before {name}</option>)}
      </select></label>}
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!valid || action.busy}>
        {group ? 'Save checklist settings' : 'Create checklist'}
      </button>
    </form>
  </WorkspaceDialog>;
}
