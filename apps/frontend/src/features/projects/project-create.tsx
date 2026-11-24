import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { projectCommand } from './project-api.js';
import { ProjectDialog, useProjectAction } from './project-controls.js';

export function CreateProjectButton({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const action = useProjectAction();
  const navigate = useNavigate();

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') ?? '').trim();
    const description = String(values.get('description') ?? '') || null;
    const type = values.get('type');
    if (type !== 'shared' && type !== 'private') return;
    const body = { name, description, type };
    void action.run(['projects.create', body], (csrf, key) => projectCommand('projects.create', csrf, key, { body }), (result) => {
      if (!result) return;
      setOpen(false);
      onCreated?.();
      void navigate('/projects/' + result.data.id);
    }, false);
  }

  return <>
    <button className="workspace-button workspace-button-primary project-create-button" type="button" onClick={() => {
      action.clearProblem(); setOpen(true);
    }}>Create project</button>
    {open && <ProjectDialog title="Create project" onClose={() => setOpen(false)} busy={action.busy}>
      <form className="project-form" method="post" onSubmit={create}>
        <label>Project name<input name="name" maxLength={128} required autoFocus /></label>
        <label>Description<textarea name="description" rows={3} maxLength={8000} /></label>
        <label>Visibility<select name="type" defaultValue="" required>
          <option value="" disabled>Choose visibility</option><option value="private">Private</option><option value="shared">Shared</option>
        </select></label>
        {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
        <button className="workspace-button workspace-button-primary" type="submit" disabled={action.busy}>
          {action.busy ? 'Creating…' : 'Create project'}
        </button>
      </form>
    </ProjectDialog>}
  </>;
}
