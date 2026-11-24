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

function useObservedRevision(revision: number, projectRevision?: number) {
  const [observed, setObserved] = useState({ revision, projectRevision });
  return { ...observed, changed: observed.revision !== revision || observed.projectRevision !== projectRevision,
    review: () => setObserved({ revision, projectRevision }) };
}

function FieldRevisionChange({ review, children }: { review: () => void; children: string }) {
  return <div role="alert">
    <p>{children}</p>
    <button className="workspace-button" type="button" onClick={review}>Review current version</button>
  </div>;
}

export function GroupForm({ owner, group, close }: { owner: FieldOwner; group?: FieldGroup; close: Close }) {
  const action = useFieldMutation();
  const [name, setName] = useState(group?.localName ?? '');
  const [template, setTemplate] = useState('');
  const ordinaryName = name.trim();
  const valid = (name === group?.localName || ordinaryName.length <= 128) && (!!ordinaryName || !!template || !!group?.linked);
  const project = owner.scope === 'project';
  const base = project ? 'field template' : 'field group';
  const observed = useObservedRevision(group?.revision ?? owner.revision);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || observed.changed) return;
    if (group && (name === group.localName || (ordinaryName || null) === group.localName)) { close(); return; }
    const operation = group ? 'fields.updateGroup' : project ? 'fields.createTemplate' : 'fields.createGroup';
    const options = { id: group?.id ?? owner.id, revision: observed.revision,
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
      {observed.changed && <FieldRevisionChange review={() => { action.clearProblem(); observed.review(); }}>
        {group ? 'The group changed. Current name: ' + group.name : 'The group’s parent changed while this form was open.'}
      </FieldRevisionChange>}
      {action.problem && !observed.changed && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy || !valid || observed.changed}>
        {group ? 'Save name' : project ? 'Create template' : 'Create group'}</button>
    </form>
  </WorkspaceDialog>;
}

export function DefinitionForm({ group, field, close }: { group: FieldGroup; field?: Definition; close: Close }) {
  const action = useFieldMutation();
  const [draftName, setName] = useState<string>();
  const [draftFront, setFront] = useState<boolean>();
  const name = draftName ?? field?.name ?? '';
  const front = draftFront ?? field?.showOnFront ?? false;
  const observed = useObservedRevision(field?.revision ?? group.revision);
  const valid = name === field?.name || (name.trim().length > 0 && name.trim().length <= 128);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || observed.changed) return;
    const operation = field ? 'fields.update' : 'fields.create';
    const options = { id: field?.id ?? group.id, revision: observed.revision, body: {
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
      {observed.changed && <FieldRevisionChange review={() => { action.clearProblem(); observed.review(); }}>
        {field ? 'The field changed. Current name: ' + field.name + (field.showOnFront ? '. Shown on card front.' : '. Inspector only.')
          : 'The field group changed while this form was open.'}
      </FieldRevisionChange>}
      {action.problem && !observed.changed && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-primary" disabled={!valid || action.busy || observed.changed}>{field ? 'Save field' : 'Create field'}</button>
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
  const observed = useObservedRevision(field?.revision ?? group.revision, kind === 'promote' ? owner.projectRevision : undefined);
  const options = { id: field?.id ?? group.id, revision: observed.revision, body: {
    ...(field && { groupId: group.id }), ...(kind === 'deleteGroup' && { confirm: true }),
    ...(kind === 'promote' && { projectRevision: observed.projectRevision }),
  } };
  return <WorkspaceDialog title={title} busy={action.busy} onClose={close}>
    <p className="field-value">{field?.name ?? group.name}</p>
    <p>{detail}</p>
    {observed.changed && <FieldRevisionChange review={() => { action.clearProblem(); observed.review(); }}>
      The field or its parent changed while this confirmation was open.
    </FieldRevisionChange>}
    {action.problem && !observed.changed && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <button className={'workspace-button ' + (kind.startsWith('delete') ? 'workspace-button-danger' : 'workspace-button-primary')}
      type="button" disabled={action.busy || observed.changed} onClick={() =>
        void action.run([operation, options], (csrf, key) => fieldCommand(operation, csrf, key, options), close)}>
      {kind.startsWith('delete') ? 'Confirm deletion' : title}
    </button>
  </WorkspaceDialog>;
}
