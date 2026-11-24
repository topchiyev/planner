import { Link } from 'react-router';
import type { WorkspaceReadOutput } from '@planner/contracts';
import './checklists.css';

export type Checklist = WorkspaceReadOutput<'cardChecklists'>['data'][number];
export type Task = Checklist['tasks'][number];

export function taskName(task: Task) {
  if (task.kind === 'linked') return task.linkedCard.name;
  return task.kind === 'task' ? task.name : 'Linked card unavailable';
}

export function shownTasks(checklist: Checklist) {
  return checklist.tasks.filter((task) => !checklist.hideCompleted
    || task.kind === 'unavailable'
    || !(task.kind === 'task' ? task.completed : task.linkedCard.completed));
}

export function TaskDisplay({ task, checklistPreview = false }: { task: Task; checklistPreview?: boolean }) {
  if (task.kind === 'unavailable') return <span className="checklist-unavailable">Linked card unavailable</span>;
  if (task.kind === 'linked') return <>
    <Link to={`/boards/${task.linkedCard.boardId}/cards/${task.linkedCard.id}`}>{task.linkedCard.name}</Link>
    {task.linkedCard.completed && <span className="checklist-status">Complete</span>}
    {!checklistPreview && task.assignee && <span className="checklist-status">{task.assignee.name}</span>}
  </>;
  return <>
    <span>{task.name}</span>
    {task.completed && <span className="checklist-status">Complete</span>}
    {!checklistPreview && task.assignee && <span className="checklist-status">{task.assignee.name}</span>}
  </>;
}

export function FrontChecklists({ groups }: { groups: Checklist[] }) {
  if (!groups.length) return null;
  return <div className="front-checklists">
    {groups.map((group) => <section key={group.id} aria-label={group.name}>
      <strong>{group.name}</strong>
      <ul className="front-checklist-items">
        {shownTasks(group).map((task) => <li key={task.id}><TaskDisplay task={task} checklistPreview /></li>)}
      </ul>
    </section>)}
  </div>;
}
