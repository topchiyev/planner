import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { projectGradientSchema, type ProjectBackground } from '@planner/contracts';
import { ConfirmResourceName, resourceNameConfirmation } from '../workspace/confirm-resource-name.js';
import type { loadNativeProject } from '../workspace/workspace-loaders.js';
import { ProjectFieldTemplates } from '../fields/workspace-fields.js';
import { ProjectDialog, useProjectAction } from './project-controls.js';
import { ProjectManagersDialog } from './project-managers.js';
import { projectBackgroundImage, projectCommand, removeProjectBackground, uploadProjectBackground } from './project-api.js';

type Project = NonNullable<Awaited<ReturnType<typeof loadNativeProject>>>;
const gradients = { mist: 'Mist', harbor: 'Harbor', fern: 'Fern', dusk: 'Dusk' } as const;

export function ProjectBackgroundPreview({ project }: { project: Project }) {
  const { background } = project;
  if (!background) return null;
  if (background.kind === 'preset') return <div aria-hidden="true" className="project-banner project-gradient" data-gradient={background.preset} />;
  return <img className="project-banner" alt="" src={projectBackgroundImage(project.id, background.id, 'large')} />;
}

export function ProjectSettingsControls({ project }: { project: Project }) {
  const { canChangeOwnership, canDelete, canEdit, canManageManagers, canToggleHidden } = project.permissions;
  const [dialog, setDialog] = useState<'settings' | 'managers' | 'delete' | null>(null);
  useEffect(() => {
    if ((dialog === 'settings' && !(canEdit || canToggleHidden || canChangeOwnership))
        || (dialog === 'managers' && !canManageManagers) || (dialog === 'delete' && !canDelete)) setDialog(null);
  }, [dialog, canChangeOwnership, canDelete, canEdit, canManageManagers, canToggleHidden]);
  const close = () => setDialog(null);
  return <>
    {(canEdit || canToggleHidden || canChangeOwnership) && <button className="workspace-button" type="button"
      onClick={() => setDialog('settings')}>Project settings</button>}
    {canManageManagers && <button className="workspace-button" type="button" onClick={() => setDialog('managers')}>Managers</button>}
    {canDelete && <button className="workspace-button workspace-button-danger" type="button" onClick={() => setDialog('delete')}>Delete project</button>}
    {dialog === 'settings' && (canEdit || canToggleHidden || canChangeOwnership) && <SettingsDialog project={project} close={close} />}
    {dialog === 'managers' && canManageManagers && <ProjectManagersDialog project={project} close={close} />}
    {dialog === 'delete' && canDelete && <DeleteDialog project={project} close={close} />}
  </>;
}

function SettingsDialog({ project, close }: { project: Project; close: () => void }) {
  const action = useProjectAction();
  const [name, setName] = useState<string>();
  const [description, setDescription] = useState<string>();
  const [confirmType, setConfirmType] = useState<'private' | 'shared' | null>(null);
  const [image, setImage] = useState<{ file: File; signature: string }>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const { id, revision, permissions } = project;

  useEffect(() => {
    if (!permissions.canEdit) {
      setName(undefined);
      setDescription(undefined);
      setImage(undefined);
    }
  }, [permissions.canEdit]);

  function patch(body: object, onChange?: () => void) {
    return action.run(['projects.update', id, revision, body], (csrf, key) => projectCommand('projects.update', csrf, key, { id, revision, body }),
      (result) => {
        onChange?.();
        if (result && 'applied' in result.data) {
          close();
          void navigate('/workspace', { replace: true });
        }
      });
  }
  function updateDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const changes = {
      ...(name !== undefined && name.trim() !== project.name && { name: name.trim() }),
      ...(description !== undefined && (description || null) !== project.description && { description: description || null }),
    };
    if (Object.keys(changes).length) void patch(changes, () => { setName(undefined); setDescription(undefined); });
  }
  function choose(background: ProjectBackground) {
    if (JSON.stringify(background) !== JSON.stringify(project.background)) void patch({ background });
  }
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!image) return;
    const form = event.currentTarget;
    void action.run(['upload-background', id, revision, image.signature], (csrf, key) => uploadProjectBackground(id, revision, image.file, csrf, key),
      () => { setImage(undefined); form.reset(); });
  }

  return <ProjectDialog title="Project settings" onClose={close} busy={action.busy}>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {permissions.canEdit && <form className="project-form" method="post" onSubmit={updateDetails}>
      <label>Project name<input name="name" value={name ?? project.name} maxLength={128} required onChange={(event) => setName(event.target.value)} /></label>
      <label>Description<textarea name="description" value={description ?? project.description ?? ''} rows={3} maxLength={8000}
        onChange={(event) => setDescription(event.target.value)} /></label>
      <button className="workspace-button workspace-button-primary" type="submit" disabled={action.busy || (name === undefined && description === undefined)}>
        Save project details
      </button>
    </form>}
    {permissions.canEdit && <ProjectFieldTemplates project={project} />}
    {(permissions.canToggleHidden || permissions.canChangeOwnership) && <section className="project-settings-section" aria-label="Project access">
      <h3>Project access</h3>
      <p>{project.type === 'private' ? 'Private project' : 'Shared project'}{project.hidden ? ' · Hidden' : ''}</p>
      <div className="project-actions">
        {permissions.canToggleHidden && <button className="workspace-button" type="button" disabled={action.busy}
          onClick={() => void patch({ hidden: !project.hidden })}>{project.hidden ? 'Show project' : 'Hide project'}</button>}
        {permissions.canChangeOwnership && !confirmType && <button className="workspace-button" type="button" disabled={action.busy}
          onClick={() => setConfirmType(project.type === 'private' ? 'shared' : 'private')}>
          {project.type === 'private' ? 'Make shared' : 'Make private'}
        </button>}
      </div>
      {permissions.canChangeOwnership && confirmType && confirmType !== project.type && <div className="project-confirm" role="group" aria-label="Confirm project access">
        <p>{confirmType === 'shared' ? 'Release private ownership? The current owner will stay a project manager.'
          : 'Make this project private? The sole eligible manager will become its owner.'}</p>
        <div className="project-actions">
          <button type="button" className="workspace-button workspace-button-primary" disabled={action.busy}
            onClick={() => void patch({ type: confirmType }, () => setConfirmType(null))}>Confirm {confirmType === 'shared' ? 'shared' : 'private'}</button>
          <button type="button" className="workspace-button" disabled={action.busy} onClick={() => setConfirmType(null)}>Cancel</button>
        </div>
      </div>}
    </section>}
    {permissions.canEdit && <section className="project-settings-section" aria-label="Project background">
      <h3>Project background</h3>
      <div className="project-gradient-options" role="group" aria-label="Background gradients">
        <button type="button" className="workspace-button" aria-pressed={project.background === null} disabled={action.busy}
          onClick={() => choose(null)}>None</button>
        {projectGradientSchema.options.map((preset) => <button key={preset} type="button" className="workspace-button"
          aria-pressed={project.background?.kind === 'preset' && project.background.preset === preset}
          disabled={action.busy} onClick={() => choose({ kind: 'preset', preset })}>
          <span aria-hidden="true" className="project-gradient project-gradient-swatch" data-gradient={preset} />{gradients[preset]}
        </button>)}
      </div>
      <form className="project-form" method="post" onSubmit={upload}>
        <label>Background image<input type="file" name="image" accept="image/jpeg,image/png,image/gif,image/webp" disabled={action.busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            setImage(file ? { file, signature: crypto.randomUUID() } : undefined);
          }} /></label>
        <button className="workspace-button" type="submit" disabled={action.busy || !image}>Upload image</button>
      </form>
      {revalidator.state === 'idle' && !!project.backgrounds?.length && <ul className="project-background-list" aria-label="Uploaded backgrounds">
        {project.backgrounds.map((ref) => <li key={ref.id}>
          <img alt="" src={projectBackgroundImage(id, ref.id)} />
          <span>{ref.name}</span>
          <div className="project-actions">
            <button type="button" className="workspace-button" aria-label={`Use ${ref.name}`}
              aria-pressed={project.background?.kind === 'image' && project.background.id === ref.id}
              disabled={action.busy} onClick={() => choose({ kind: 'image', id: ref.id })}>Use image</button>
            <button type="button" className="workspace-button" aria-label={`Remove ${ref.name}`} disabled={action.busy}
              onClick={() => void action.run(['remove-background', id, revision, ref.id],
                (csrf, key) => removeProjectBackground(id, ref.id, revision, csrf, key))}>Remove</button>
          </div>
        </li>)}
      </ul>}
    </section>}
  </ProjectDialog>;
}

function DeleteDialog({ project, close }: { project: Project; close: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  const action = useProjectAction();
  const navigate = useNavigate();
  const { id, revision, name } = project;
  const confirmed = confirmation === resourceNameConfirmation(name);
  return <ProjectDialog title="Delete project" onClose={close} busy={action.busy}>
    <form className="project-form" method="post" onSubmit={(event) => {
      event.preventDefault();
      if (!confirmed) return;
      void action.run(['delete', id, revision, name], (csrf, key) => projectCommand('projects.delete', csrf, key, { id, revision, body: { name } }),
        () => { close(); void navigate('/workspace', { replace: true }); }, false);
    }}>
      <ConfirmResourceName resource="project" name={name} value={confirmation} onChange={setConfirmation} />
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button className="workspace-button workspace-button-danger" type="submit" disabled={action.busy || !confirmed}>Delete permanently</button>
    </form>
  </ProjectDialog>;
}
