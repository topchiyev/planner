import { useState, type FormEvent } from 'react';
import type { fieldGroupSchema, fieldDefinitionSchema } from '@planner/contracts';
import { WorkspaceDialog } from '../projects/project-controls.js';
import { fieldCommand, useFieldMutation } from './field-api.js';
import { FieldTemplatePicker } from './field-templates.js';

export type FieldGroup = ReturnType<typeof fieldGroupSchema.parse>;
export type Definition = ReturnType<typeof fieldDefinitionSchema.parse>;
export type FieldOwner = { id: string; revision: number; orderVersion: number; scope: FieldGroup['scopeType'];
  boardId?: string; projectRevision?: number };
type Close = () => void;

export function GroupForm({ owner, group, close }: { owner: FieldOwner; group?: FieldGroup; close: Close }) {
  const action = useFieldMutation();
  const [name, setName] = useState(group?.localName ?? '');
  const [template, setTemplate] = useState('');
  const ordinaryName = name.trim();
  const valid = (name === group?.localName || ordinaryName.length <= 128) && (!!ordinaryName || !!template || !!group?.linked);
  const project = owner.scope === 'project';
  const base = project ? 'field template' : 'field group';
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    if (group && (name === group.localName || (ordinaryName || null) === group.localName)) { close(); return; }
    const operation = group ? 'fields.updateGroup' : project ? 'fields.createTemplate' : 'fields.createGroup';
    const options = { id: group?.id ?? owner.id, revision: group?.revision ?? owner.revision,
      scope: owner.scope === 'project' ? undefined : owner.scope, body: { name: ordinaryName || null, ...(!group && !project && { templateGroupId: template || null }) } };
    void action.run([operation, options], (csrf, key) => fieldCommand(operation, csrf, key, options), close);
  }
  return <WorkspaceDialog title={(group ? 'Edit ' : 'Add ') + base} busy={action.busy} onClose={close}>
    <form className="project-form" onSubmit={submit}>
      {!group && owner.boardId && <FieldTemplatePicker boardId={owner.boardId} selected={template} select={setTemplate} onAccessLost={close} />}
      <label>{group?.linked || template ? 'Group name (optional)' : project ? 'Template name' : 'Group name'}
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus
          maxLength={Math.max(128, group?.localName?.length ?? 0)} />
      </label>
      {(group?.linked || template) && <p>Leave the name empty to use the project template name.</p>}
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy || !valid}>
        {group ? 'Save name' : project ? 'Create template' : 'Create group'}</button>
    </form>
  </WorkspaceDialog>;
}

export function DefinitionForm({ group, field, close }: { group: FieldGroup; field?: Definition; close: Close }) {
  const action = useFieldMutation();
  const [name, setName] = useState(field?.name ?? '');
  const [front, setFront] = useState(field?.showOnFront ?? false);
  const valid = name === field?.name || (name.trim().length > 0 && name.trim().length <= 128);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const operation = field ? 'fields.update' : 'fields.create';
    const options = { id: field?.id ?? group.id, revision: field?.revision ?? group.revision, body: {
      ...(field && { groupId: group.id }), ...((!field || (name !== field.name && name.trim() !== field.name)) && { name: name.trim() }),
      ...((!field || front !== field.showOnFront) && { showOnFront: front }),
    } };
    if (field && Object.keys(options.body).length === 1) { close(); return; }
    void action.run([operation, options], (csrf, key) => fieldCommand(operation, csrf, key, options), close);
  }
  return <WorkspaceDialog title={field ? 'Edit field' : 'Add field'} busy={action.busy} onClose={close}>
    <form className="project-form" onSubmit={submit}>
      <label>Field name<input value={name} autoFocus onChange={(event) => setName(event.target.value)}
        maxLength={Math.max(128, field?.name.length ?? 0)} /></label>
      <label className="board-checkbox"><input type="checkbox" checked={front} onChange={(event) => setFront(event.target.checked)} />
        Show on card front</label>
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-primary" disabled={!valid || action.busy}>{field ? 'Save field' : 'Create field'}</button>
    </form>
  </WorkspaceDialog>;
}

type Confirmation = 'detach' | 'promote' | 'deleteGroup' | 'deleteField';
const confirmation = {
  detach: ['Detach field group', 'Create local field definitions and keep this group’s values.'],
  promote: ['Save as project template', 'Copy the field names, order and display settings into a reusable project template. Values stay in the original group.'],
  deleteGroup: ['Delete field group', 'Permanently remove this group, its fields and saved values. Deleting a project template also removes its linked groups.'],
  deleteField: ['Delete field', 'Permanently remove this field and its saved values.'],
} as const;

export function FieldConfirmation({ kind, owner, group, field, close }: {
  kind: Confirmation; owner: FieldOwner; group: FieldGroup; field?: Definition; close: Close;
}) {
  const action = useFieldMutation();
  const [title, detail] = confirmation[kind];
  const operation = kind === 'deleteField' ? 'fields.delete' : kind === 'deleteGroup' ? 'fields.deleteGroup'
    : kind === 'detach' ? 'fields.detachGroup' : 'fields.promoteGroup';
  const options = { id: field?.id ?? group.id, revision: field?.revision ?? group.revision, body: {
    ...(field && { groupId: group.id }), ...(kind === 'deleteGroup' && { confirm: true }),
    ...(kind === 'promote' && { projectRevision: owner.projectRevision }),
  } };
  return <WorkspaceDialog title={title} busy={action.busy} onClose={close}>
    <p>{detail}</p>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <button className={'workspace-button ' + (kind.startsWith('delete') ? 'workspace-button-danger' : 'workspace-button-primary')}
      type="button" disabled={action.busy} onClick={() =>
        void action.run([operation, options], (csrf, key) => fieldCommand(operation, csrf, key, options), close)}>
      {kind.startsWith('delete') ? 'Confirm deletion' : title}
    </button>
  </WorkspaceDialog>;
}
