import { useState, type FormEvent } from 'react';
import { labelColorSchema, type LabelColor } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import { LabelChip, labelColorName, labelName, PersonalFollow, useAffiliationMutation, type Label } from './affiliation-ui.js';

type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;

export function BoardAffiliations({ workspace }: { workspace: Workspace }) {
  const [palette, setPalette] = useState(false);
  const { board, following } = workspace;
  return <div className="project-actions board-affiliations">
    {board.permissions.canFollow && <PersonalFollow resource="board" id={board.id} revision={board.revision} following={following} />}
    <button className="workspace-button" type="button" onClick={() => setPalette(true)}>Board labels</button>
    {palette && <LabelPalette workspace={workspace} close={() => setPalette(false)} />}
  </div>;
}

function LabelPalette({ workspace, close }: { workspace: Workspace; close: () => void }) {
  const action = useAffiliationMutation();
  const [editing, setEditing] = useState<{ id: string } | { create: true }>();
  const [deleting, setDeleting] = useState<string>();
  const { board, labels } = workspace;
  const editable = board.permissions.canEdit;
  const selected = editing && 'id' in editing ? labels.find(({ id }) => id === editing.id) : undefined;
  const removed = labels.find(({ id }) => id === deleting);

  function save(changes: { name?: string | null; color?: LabelColor }) {
    const operation = selected ? 'labels.update' : 'labels.create';
    const { id, revision } = selected ?? board;
    void action.run([operation, id, revision, changes], (csrf, key) =>
      relationshipCommand(operation, csrf, key, { id, revision, body: changes }), () => setEditing(undefined));
  }

  return <WorkspaceDialog title="Board labels" busy={action.busy} onClose={close}>
    {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
    {editable && <button className="workspace-button workspace-button-primary" type="button" disabled={action.busy}
      onClick={() => { action.clearProblem(); setDeleting(undefined); setEditing({ create: true }); }}>New label</button>}
    {editable && editing && (selected || 'create' in editing) && <LabelForm key={selected?.id ?? 'new'}
      label={selected} busy={action.busy} onSave={save} cancel={() => setEditing(undefined)} />}
    {!labels.length && !editing && <p>No labels yet.</p>}
    {labels.length > 0 && <ul className="board-palette" aria-label="Labels">
      {labels.map((label) => <li key={label.id}>
        <LabelChip label={label} />
        {editable && <div className="project-actions">
          <button className="workspace-button" type="button" aria-label={'Edit label ' + labelName(label)}
            disabled={action.busy} onClick={() => { action.clearProblem(); setDeleting(undefined); setEditing({ id: label.id }); }}>Edit</button>
          <button className="workspace-button" type="button" aria-label={'Delete label ' + labelName(label)}
            disabled={action.busy} onClick={() => { action.clearProblem(); setEditing(undefined); setDeleting(label.id); }}>Delete</button>
        </div>}
      </li>)}
    </ul>}
    {editable && removed && <div className="project-confirm" role="group" aria-label="Confirm label deletion">
      <p>Delete <strong>{labelName(removed)}</strong> from this board and its cards?</p>
      <div className="project-actions">
        <button className="workspace-button workspace-button-danger" type="button" disabled={action.busy}
          onClick={() => void action.run(['labels.delete', removed.id, removed.revision], (csrf, key) =>
            relationshipCommand('labels.delete', csrf, key, { id: removed.id, revision: removed.revision }),
          () => setDeleting(undefined))}>Confirm label deletion</button>
        <button className="workspace-button" type="button" disabled={action.busy} onClick={() => setDeleting(undefined)}>Cancel</button>
      </div>
    </div>}
  </WorkspaceDialog>;
}

function LabelForm({ label, busy, onSave, cancel }: {
  label?: Label; busy: boolean; onSave: (changes: { name?: string | null; color?: LabelColor }) => void; cancel: () => void;
}) {
  const [name, setName] = useState<string>();
  const [color, setColor] = useState<LabelColor>();
  const startingColor = label ? labelColorSchema.safeParse(label.color).data : labelColorSchema.options[0];
  const shownName = name ?? label?.name ?? '';
  const shownColor = color ?? startingColor;
  const nameChanged = name !== undefined && (name.trim() || null) !== (label?.name ?? null);
  const colorChanged = color !== undefined && color !== startingColor;
  const hasChanges = !label || nameChanged || colorChanged;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !hasChanges) return;
    if (label) onSave({ ...(nameChanged && { name: name!.trim() || null }), ...(colorChanged && { color }) });
    else onSave({ name: shownName.trim() || null, color: shownColor! });
  }

  return <form className="project-form palette-form" method="post" onSubmit={submit}>
    <label>Label name <input value={shownName} maxLength={128} placeholder="Optional" onChange={(event) => setName(event.target.value)} /></label>
    <label>Label color<select value={shownColor ?? ''} onChange={(event) => setColor(labelColorSchema.safeParse(event.target.value).data)}>
      {!startingColor && <option value="">Keep existing color</option>}
      {labelColorSchema.options.map((value) => <option key={value} value={value}>{labelColorName(value)}</option>)}
    </select></label>
    <div><LabelChip label={{ name: shownName, color: shownColor ?? label?.color ?? null }} /></div>
    <div className="project-actions">
      <button className="workspace-button workspace-button-primary" type="submit" disabled={busy || !hasChanges}>{label ? 'Save label' : 'Create label'}</button>
      <button className="workspace-button" type="button" disabled={busy} onClick={cancel}>Cancel</button>
    </div>
  </form>;
}
