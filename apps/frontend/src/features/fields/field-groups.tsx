import { useState, type ReactNode } from 'react';
import { fieldCommand, useFieldMutation } from './field-api.js';
import { DefinitionForm, FieldConfirmation, GroupForm, type Definition, type FieldGroup, type FieldOwner } from './field-structure-forms.js';
import './fields.css';

type Dialog = 'name' | 'detach' | 'promote' | 'deleteGroup' | 'createField' | { kind: 'edit' | 'deleteField'; id: string };

export function FieldGroups({ owner, groups, editable, children }: {
  owner: FieldOwner; groups: FieldGroup[]; editable: boolean;
  children?: (group: FieldGroup, definition: Definition) => ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const local = groups.filter(({ scopeType, scopeId }) => scopeType === owner.scope && scopeId === owner.id);
  return <>
    {editable && <button className="workspace-button" type="button" onClick={() => setCreating(true)}>
      {owner.scope === 'project' ? 'Add field template' : 'Add field group'}
    </button>}
    {editable && creating && <GroupForm owner={owner} close={() => setCreating(false)} />}
    {!groups.length && <p>No fields yet.</p>}
    {groups.map((group) => <FieldGroupPanel key={group.id} owner={owner} group={group} siblings={local}
      editable={editable && local.includes(group)} renderValue={children} />)}
  </>;
}

function FieldGroupPanel({ owner, group, siblings, editable, renderValue }: {
  owner: FieldOwner; group: FieldGroup; siblings: FieldGroup[]; editable: boolean;
  renderValue?: (group: FieldGroup, definition: Definition) => ReactNode;
}) {
  const action = useFieldMutation();
  const [dialog, open] = useState<Dialog | null>(null);
  const [status, setStatus] = useState('');
  const close = () => open(null);
  const groupIndex = siblings.indexOf(group);
  const local = group.definitions.filter(({ inherited }) => !inherited);
  const selected = dialog && typeof dialog === 'object' ? local.find(({ id }) => id === dialog.id) : undefined;
  function moveGroup(direction: -1 | 1) {
    const beforeGroupId = direction === -1 ? siblings[groupIndex - 1].id : siblings[groupIndex + 2]?.id ?? null;
    const options = { id: group.id, revision: group.revision, body: { beforeGroupId, orderVersion: owner.orderVersion } };
    void action.run(['fields.updateGroup', options], (csrf, key) => fieldCommand('fields.updateGroup', csrf, key, options),
      () => setStatus('Field group moved.'));
  }
  function moveField(field: Definition, index: number, direction: -1 | 1) {
    const beforeFieldId = direction === -1 ? local[index - 1].id : local[index + 2]?.id ?? null;
    const options = { id: field.id, revision: field.revision, body: { groupId: group.id, beforeFieldId, orderVersion: group.orderVersion } };
    void action.run(['fields.update', options], (csrf, key) => fieldCommand('fields.update', csrf, key, options),
      () => setStatus('Field moved.'));
  }
  return <section className="field-group" aria-label={group.name}>
    <h4>{group.name}</h4>
    {group.linked && <p className="field-note">Linked to a project template</p>}
    {renderValue && group.scopeType === 'board' && <p className="field-note">Board field group</p>}
    {editable && <div className="project-actions">
      <button type="button" className="workspace-button" onClick={() => open('createField')}>Add field</button>
      <button type="button" className="workspace-button" onClick={() => open('name')}>Edit group name</button>
      {group.linked && <button type="button" className="workspace-button" onClick={() => open('detach')}>Detach</button>}
      {owner.projectRevision !== undefined && owner.scope !== 'project' &&
        <button type="button" className="workspace-button" onClick={() => open('promote')}>Save as project template</button>}
      {siblings.length > 1 && <>
        <button type="button" className="workspace-button" disabled={groupIndex <= 0 || action.busy}
          aria-label={`Move field group ${group.name} up`} onClick={() => moveGroup(-1)}>Move up</button>
        <button type="button" className="workspace-button" disabled={groupIndex >= siblings.length - 1 || action.busy}
          aria-label={`Move field group ${group.name} down`} onClick={() => moveGroup(1)}>Move down</button>
      </>}
      <button type="button" className="workspace-button" onClick={() => open('deleteGroup')}>Delete group</button>
    </div>}
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {status && <p role="status">{status}</p>}
    <ul className="field-definitions">
      {group.definitions.map((field) => {
        const index = local.indexOf(field);
        return <li key={field.id}>
          <div className="field-heading">
            <strong>{field.name}</strong>
            <span className="field-note">{field.showOnFront ? 'Shown on card front' : 'Inspector only'}
              {field.inherited ? ' · Inherited' : ''}</span>
          </div>
          {renderValue?.(group, field)}
          {editable && !field.inherited && <div className="project-actions">
            <button type="button" className="workspace-button" aria-label={`Edit field ${field.name}`}
              onClick={() => open({ kind: 'edit', id: field.id })}>Edit</button>
            {local.length > 1 && <>
              <button type="button" className="workspace-button" disabled={index <= 0 || action.busy}
                aria-label={`Move field ${field.name} up`} onClick={() => moveField(field, index, -1)}>Move up</button>
              <button type="button" className="workspace-button" disabled={index >= local.length - 1 || action.busy}
                aria-label={`Move field ${field.name} down`} onClick={() => moveField(field, index, 1)}>Move down</button>
            </>}
            <button type="button" className="workspace-button" aria-label={`Delete field ${field.name}`}
              onClick={() => open({ kind: 'deleteField', id: field.id })}>Delete</button>
          </div>}
        </li>;
      })}
    </ul>
    {editable && dialog === 'name' && <GroupForm owner={owner} group={group} close={close} />}
    {editable && (dialog === 'createField' || (selected && typeof dialog === 'object' && dialog?.kind === 'edit')) &&
      <DefinitionForm group={group} field={selected} close={close} />}
    {editable && (dialog === 'detach' || dialog === 'promote' || dialog === 'deleteGroup') &&
      <FieldConfirmation kind={dialog} owner={owner} group={group} close={close} />}
    {editable && selected && typeof dialog === 'object' && dialog?.kind === 'deleteField' &&
      <FieldConfirmation kind="deleteField" owner={owner} group={group} field={selected} close={close} />}
  </section>;
}
