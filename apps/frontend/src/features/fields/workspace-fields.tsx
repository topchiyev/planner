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

type CardValueProps = { card: Card; group: FieldGroup; field: Definition; value?: string };

function CardValue(props: CardValueProps) {
  const { card, value } = props;
  if (!card.permissions.canEdit) return <p className="field-value">{value === undefined ? 'No value' : value === '' ? 'Empty value' : value}</p>;
  return <CardValueEditor {...props} />;
}

function CardValueEditor({ card, group, field, value }: CardValueProps) {
  const action = useFieldMutation();
  const version = { revision: card.revision, groupRevision: group.revision, definitionRevision: field.revision };
  const [draft, setDraft] = useState<{ value: string; version: typeof version }>();
  const current = draft?.value ?? value ?? '';
  const stale = draft !== undefined && (draft.version.revision !== version.revision
    || draft.version.groupRevision !== version.groupRevision || draft.version.definitionRevision !== version.definitionRevision);
  const valid = fieldValueTextSchema.safeParse(current).success;
  function apply(clear: boolean) {
    const { revision, groupRevision, definitionRevision } = draft?.version ?? version;
    const operation = clear ? 'fields.clearValue' : 'fields.setValue';
    const options = { id: card.id, revision, groupId: group.id, fieldId: field.id, body: {
      groupRevision, definitionRevision, ...(!clear && { value: current }),
    } };
    void action.run([operation, options], (csrf, key) => fieldCommand(operation, csrf, key, options), () => setDraft(undefined));
  }
  return <form className="project-form field-value-form" onSubmit={(event) => {
    event.preventDefault();
    if (valid && !stale) apply(false);
  }}>
    <label>{field.name} value<textarea rows={2} value={current} onChange={(event) =>
      setDraft({ value: event.target.value, version: draft?.version ?? version })} /></label>
    {!valid && <p role="status">Field values must have at most 512 Unicode characters.</p>}
    {action.problem && !stale && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {stale && <div role="alert">
      <p>The card or field changed while you were editing.</p>
      <p className="field-value">Current value: {value === undefined ? 'No value' : value === '' ? 'Empty value' : value}</p>
      <div className="project-actions">
        <button type="button" className="workspace-button" onClick={() => { action.clearProblem(); setDraft({ value: current, version }); }}>
          Keep draft
        </button>
        <button type="button" className="workspace-button" onClick={() => { action.clearProblem(); setDraft(undefined); }}>
          Use current value
        </button>
      </div>
    </div>}
    <div className="project-actions">
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy || stale || !valid || current === value}>Save value</button>
      {value !== undefined && <button type="button" className="workspace-button" disabled={action.busy || stale} onClick={() => apply(true)}>Clear value</button>}
    </div>
  </form>;
}

export function FrontFields({ fields }: { fields: Front }) {
  if (!fields.length) return null;
  return <dl className="card-front-fields">{fields.map((field) =>
    <div key={field.fieldGroupId + '/' + field.fieldDefinitionId}><dt>{field.name}</dt><dd>{field.value || 'Empty value'}</dd></div>)}</dl>;
}
