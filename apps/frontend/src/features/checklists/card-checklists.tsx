import { useId, useRef, useState } from 'react';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import { ChecklistForm, useChecklistMutation, type ChecklistCard, type Close } from './checklist-forms.js';
import { TaskDisplay, shownTasks, taskName, type Checklist, type Task } from './checklist-display.js';
import { TaskForm, TaskMove } from './task-forms.js';

export function CardChecklists({ card, groups, expand }: { card: ChecklistCard; groups: Checklist[]; expand: boolean }) {
  const [creating, setCreating] = useState(false);
  return <section className="card-checklists" aria-label="Checklists">
    <h3>Checklists</h3>
    {card.permissions.canEdit && <div>
      <button className="workspace-button" type="button" onClick={() => setCreating(true)}>Add checklist</button>
    </div>}
    {groups.map((group, index) => <ChecklistItem key={group.id} card={card} group={group} groups={groups} index={index} expand={expand} />)}
    {card.permissions.canEdit && creating && <ChecklistForm card={card} groups={groups} close={() => setCreating(false)} />}
  </section>;
}

type ActiveDialog = { kind: 'settings' | 'delete-checklist' | 'add' | 'link' }
  | { kind: 'edit-task' | 'move-task' | 'delete-task'; taskId: string };

function ChecklistItem({ card, group, groups, index, expand }: {
  card: ChecklistCard; group: Checklist; groups: Checklist[]; index: number; expand: boolean;
}) {
  const controls = useId();
  const heading = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<boolean>();
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [message, setMessage] = useState('');
  const action = useChecklistMutation();
  const expanded = open ?? expand;
  const editable = card.permissions.canEdit;
  const selected = dialog && 'taskId' in dialog ? group.tasks.find(({ id }) => id === dialog.taskId) : undefined;
  const close = () => setDialog(null);

  function move(direction: -1 | 1) {
    const beforeChecklistId = direction === -1 ? groups[index - 1].id : groups[index + 2]?.id ?? null;
    const body = { beforeChecklistId, checklistOrderVersion: card.checklistOrderVersion };
    void action.run(['checklists.update', group.id, group.revision, body], (csrf, key) =>
      relationshipCommand('checklists.update', csrf, key, { id: group.id, revision: group.revision, body }),
    () => { setMessage('Checklist moved.'); toggle.current?.focus(); });
  }

  function complete(task: Extract<Task, { kind: 'task' }>, completed: boolean) {
    const body = { completed };
    void action.run(['tasks.update', task.id, task.revision, body], (csrf, key) =>
      relationshipCommand('tasks.update', csrf, key, { id: task.id, revision: task.revision, body }));
  }

  return <section aria-labelledby={heading} className="card-checklist">
    <h4 id={heading}><button className="workspace-button checklist-toggle" type="button" ref={toggle} aria-controls={controls} aria-expanded={expanded}
      onClick={() => setOpen(!expanded)}>{group.name}</button></h4>
    <div id={controls} hidden={!expanded}>
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      {message && <p role="status">{message}</p>}
      {editable && <div className="project-actions checklist-controls">
        <button className="workspace-button" type="button" onClick={() => setDialog({ kind: 'add' })}>Add task</button>
        <button className="workspace-button" type="button" onClick={() => setDialog({ kind: 'link' })}>Link a card</button>
        <button className="workspace-button" type="button" onClick={() => setDialog({ kind: 'settings' })}>Checklist settings</button>
        {groups.length > 1 && <>
          <button type="button" className="workspace-button" disabled={index === 0 || action.busy}
            aria-label={`Move checklist ${group.name} up`} onClick={() => move(-1)}>Move up</button>
          <button type="button" className="workspace-button" disabled={index === groups.length - 1 || action.busy}
            aria-label={`Move checklist ${group.name} down`} onClick={() => move(1)}>Move down</button>
        </>}
        <button className="workspace-button workspace-button-danger" type="button" onClick={() => setDialog({ kind: 'delete-checklist' })}>Delete checklist</button>
      </div>}
      <ul className="checklist-task-list" aria-label={`Tasks in ${group.name}`}>
        {shownTasks(group).map((task) => <li key={task.id}>
          <div className="checklist-task-heading">
            {editable && task.kind === 'task' && <input type="checkbox" checked={task.completed} disabled={action.busy}
              aria-label={`Complete ${task.name}`} onChange={(event) => complete(task, event.target.checked)} />}
            <TaskDisplay task={task} />
          </div>
          {editable && <div className="project-actions">
            {task.kind === 'task' && <button className="workspace-button" type="button" aria-label={`Edit task ${task.name}`}
              onClick={() => setDialog({ kind: 'edit-task', taskId: task.id })}>Edit</button>}
            {task.kind !== 'unavailable' && (groups.length > 1 || group.tasks.length > 1) && <button className="workspace-button" type="button"
              aria-label={`Move task ${taskName(task)}`} onClick={() => setDialog({ kind: 'move-task', taskId: task.id })}>Move</button>}
            <button type="button" className="workspace-button" aria-label={`Delete task ${taskName(task)}`}
              onClick={() => setDialog({ kind: 'delete-task', taskId: task.id })}>Delete</button>
          </div>}
        </li>)}
      </ul>
    </div>
    {editable && dialog?.kind === 'settings' && <ChecklistForm card={card} group={group} groups={groups} close={close} />}
    {editable && dialog?.kind === 'add' && <TaskForm card={card} group={group} close={close} />}
    {editable && dialog?.kind === 'link' && <TaskForm card={card} group={group} linked close={close} />}
    {editable && dialog?.kind === 'edit-task' && selected?.kind === 'task' && <TaskForm card={card} group={group} task={selected} close={close} />}
    {editable && dialog?.kind === 'move-task' && selected && selected.kind !== 'unavailable' &&
      <TaskMove group={group} groups={groups} task={selected} close={close} />}
    {editable && dialog?.kind === 'delete-checklist' && <ConfirmChecklistDelete group={group} close={close} />}
    {editable && dialog?.kind === 'delete-task' && selected && <ConfirmChecklistDelete group={group} task={selected} close={close} />}
  </section>;
}

function ConfirmChecklistDelete({ group, task, close }: { group: Checklist; task?: Task; close: Close }) {
  const action = useChecklistMutation();
  const operation = task ? 'tasks.delete' : 'checklists.delete';
  const { id, revision } = task ?? group;
  return <WorkspaceDialog title={task ? 'Delete task' : 'Delete checklist'} onClose={close} busy={action.busy}>
    <p>{task ? 'Permanently remove this task?' : 'Permanently remove this checklist and its tasks?'}</p>
    {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
    <button className="workspace-button workspace-button-danger" type="button" disabled={action.busy}
      onClick={() => void action.run([operation, id, revision], (csrf, key) =>
        relationshipCommand(operation, csrf, key, { id, revision }), close)}>Confirm deletion</button>
  </WorkspaceDialog>;
}
