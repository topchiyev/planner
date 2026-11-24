import { useState } from 'react';
import { fieldValueTextSchema, type WorkspaceReadOutput } from '@planner/contracts';
import { fieldCommand, useFieldMutation } from './field-api.js';
import { FieldGroups } from './field-groups.js';
import type { Definition, FieldGroup } from './field-structure-forms.js';

type Card = WorkspaceReadOutput<'cardGet'>['data'];
type Board = WorkspaceReadOutput<'boardWorkspace'>['data'];
type Project = WorkspaceReadOutput<'projectGet'>['data'];
type Front = WorkspaceReadOutput<'boardCards'>['data'][number]['frontFields'];

export function ProjectFieldTemplates({ project }: { project: Project }) {
  if (!project.fieldTemplates || project.fieldGroupOrderVersion === null) return null;
  return <details className="workspace-field-settings">
    <summary className="workspace-button">Custom field templates</summary>
    <FieldGroups owner={{ id: project.id, revision: project.revision, orderVersion: project.fieldGroupOrderVersion, scope: 'project' }}
      groups={project.fieldTemplates} editable={project.permissions.canEdit} />
  </details>;
}

export function BoardFieldGroups({ workspace }: { workspace: Board }) {
  const { board, project, fields, fieldGroupOrderVersion } = workspace;
  if (!fields.length && !board.permissions.canEdit) return null;
  return <details className="workspace-field-settings">
    <summary className="workspace-button">Board fields</summary>
    <FieldGroups owner={{ id: board.id, revision: board.revision, orderVersion: fieldGroupOrderVersion, scope: 'board', boardId: board.id,
      projectRevision: project.permissions.canEdit ? project.revision : undefined }} groups={fields} editable={board.permissions.canEdit} />
  </details>;
}

export function CardFields({ card, project }: { card: Card; project: Board['project'] | undefined }) {
  if (!card.fields.length && !card.permissions.canEdit) return null;
  const values = new Map(card.values.map(({ fieldGroupId, fieldDefinitionId, value }) => [fieldGroupId + '/' + fieldDefinitionId, value]));
  return <section className="card-fields" aria-label="Custom fields">
    <h3>Custom fields</h3>
    <FieldGroups owner={{ id: card.id, revision: card.revision, orderVersion: card.fieldGroupOrderVersion, scope: 'card', boardId: card.boardId,
      projectRevision: project?.permissions.canEdit ? project.revision : undefined }} groups={card.fields} editable={card.permissions.canEdit}>
      {(group, field) => <CardValue card={card} group={group} field={field} value={values.get(group.id + '/' + field.id)} />}
    </FieldGroups>
  </section>;
}

function CardValue({ card, group, field, value }: { card: Card; group: FieldGroup; field: Definition; value?: string }) {
  const action = useFieldMutation();
  const [draft, setDraft] = useState<string>();
  const current = draft ?? value ?? '';
  const valid = fieldValueTextSchema.safeParse(current).success;
  function apply(clear: boolean) {
    const operation = clear ? 'fields.clearValue' : 'fields.setValue';
    const options = { id: card.id, revision: card.revision, groupId: group.id, fieldId: field.id, body: {
      groupRevision: group.revision, definitionRevision: field.revision, ...(!clear && { value: current }),
    } };
    void action.run([operation, options], (csrf, key) => fieldCommand(operation, csrf, key, options), () => setDraft(undefined));
  }
  if (!card.permissions.canEdit) return <p className="field-value">{value === undefined ? 'No value' : value === '' ? 'Empty value' : value}</p>;
  return <form className="project-form field-value-form" onSubmit={(event) => {
    event.preventDefault();
    if (valid) apply(false);
  }}>
    <label>{field.name} value<textarea rows={2} value={current} onChange={(event) => setDraft(event.target.value)} /></label>
    {!valid && <p role="status">Field values must have at most 512 Unicode characters.</p>}
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <div className="project-actions">
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy || !valid || current === value}>Save value</button>
      {value !== undefined && <button type="button" className="workspace-button" disabled={action.busy} onClick={() => apply(true)}>Clear value</button>}
    </div>
  </form>;
}

export function FrontFields({ fields }: { fields: Front }) {
  if (!fields.length) return null;
  return <dl className="card-front-fields">{fields.map((field) =>
    <div key={field.fieldGroupId + '/' + field.fieldDefinitionId}><dt>{field.name}</dt><dd>{field.value || 'Empty value'}</dd></div>)}</dl>;
}
