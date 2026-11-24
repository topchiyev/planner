import { useEffect, useState, type FormEvent } from 'react';
import { useRevalidator } from 'react-router';
import { type RelationshipReadOutput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { useEligibleMemberPage } from '../affiliations/eligible-member-page.js';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import { taskName, type Checklist, type Task } from './checklist-display.js';
import { useChecklistMutation, type ChecklistCard, type Close } from './checklist-forms.js';

type Person = RelationshipReadOutput<'boards.mentionMembers'>['data'][number];
type Ordinary = Extract<Task, { kind: 'task' }>;

function cardReference(input: string) {
  const id = publicIdSchema.safeParse(input.trim());
  if (id.success) return id.data;
  if (!input.trim()) return null;
  try {
    const url = new URL(input.trim(), window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password) return null;
    const match = /^\/boards\/([^/]+)\/cards\/([^/]+)\/?$/u.exec(url.pathname);
    if (!match || !publicIdSchema.safeParse(match[1]).success) return null;
    return publicIdSchema.safeParse(match[2]).data ?? null;
  } catch {
    return null;
  }
}

function Assignee({ card, selected, choose, unavailable }: {
  card: ChecklistCard; selected: Person | null; choose: (value: Person | null) => void; unavailable: Close;
}) {
  const [query, setQuery] = useState('');
  const candidates = useEligibleMemberPage(card.boardId, card.revision);
  const revalidator = useRevalidator();
  const { accessLost, result, cursor } = candidates;
  useEffect(() => {
    if (accessLost) {
      unavailable();
      void revalidator.revalidate();
    }
  }, [accessLost, unavailable, revalidator]);
  return <fieldset className="board-option-set checklist-assignees">
    <legend>Assignee</legend>
    {selected && <p>{selected.name}</p>}
    <div className="project-actions">
      <button className="workspace-button" type="button" aria-pressed={!selected} onClick={() => choose(null)}>Unassigned</button>
    </div>
    <label>Find an assignee<input type="search" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); candidates.search(query); }
      }} /></label>
    <button className="workspace-button" type="button" onClick={() => candidates.search(query)}>Search members</button>
    {!result ? <p role="status">Loading board members…</p> : !result.page ? <p role="alert">Board members couldn’t load.
      <button className="workspace-button" type="button" onClick={candidates.retry}>Retry</button>
    </p> : <>
      {result.page.data.length ? <ul className="board-palette" aria-label="Eligible task assignees">
        {result.page.data.map((person) => <li key={person.id}>
          <button type="button" className="workspace-button" aria-pressed={selected?.id === person.id}
            onClick={() => choose(person)}>{person.name}{person.username ? ' · @' + person.username : ''}</button>
        </li>)}
      </ul> : <p>No matching board members.</p>}
      {(cursor || result.page.page.nextCursor) && <nav aria-label="Assignee pages" className="project-actions">
        {cursor && <button className="workspace-button" type="button" onClick={() => candidates.setCursor(undefined)}>First page</button>}
        {result.page.page.nextCursor && <button className="workspace-button" type="button"
          onClick={() => candidates.setCursor(result.page?.page.nextCursor ?? undefined)}>Next page</button>}
      </nav>}
    </>}
  </fieldset>;
}

export function TaskForm({ card, group, task, linked = false, close }: {
  card: ChecklistCard; group: Checklist; task?: Ordinary; linked?: boolean; close: Close;
}) {
  const action = useChecklistMutation();
  const [name, setName] = useState(task?.name ?? '');
  const [selected, setSelected] = useState<Person | null>(task?.assignee ?? null);
  const [reference, setReference] = useState('');
  const [before, setBefore] = useState('');
  const [showPeople, setShowPeople] = useState(false);
  const linkedCardId = linked ? cardReference(reference) : null;
  const valid = linked ? linkedCardId !== null : !!name.trim() && (name === task?.name || name.trim().length <= 128);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    if (task) {
      const body = { ...(name !== task.name && name.trim() !== task.name && { name: name.trim() }),
        ...(selected?.id !== task.assignee?.id && { assigneeId: selected?.id ?? null }) };
      if (!Object.keys(body).length) { close(); return; }
      void action.run(['tasks.update', task.id, task.revision, body], (csrf, key) =>
        relationshipCommand('tasks.update', csrf, key, { id: task.id, revision: task.revision, body }), close);
    } else {
      const body = linkedCardId ? { linkedCardId, beforeTaskId: before || null }
        : { name: name.trim(), assigneeId: selected?.id ?? null, beforeTaskId: before || null };
      void action.run(['tasks.create', group.id, group.revision, body], (csrf, key) =>
        relationshipCommand('tasks.create', csrf, key, { id: group.id, revision: group.revision, body }), close);
    }
  }

  const title = task ? 'Edit task' : linked ? 'Link a card' : 'Add task';
  return <WorkspaceDialog title={title} onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={submit}>
      {linked ? <label>Card link or ID<input value={reference} onChange={(event) => setReference(event.target.value)}
        required autoFocus autoComplete="off" maxLength={2048} /></label> : <>
        <label>Task name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus required
          maxLength={Math.max(128, task?.name.length ?? 0)} /></label>
        <div className="project-actions">
          <button type="button" className="workspace-button" aria-expanded={showPeople} onClick={() => setShowPeople(!showPeople)}>
            {selected ? 'Change assignee' : 'Choose assignee'}
          </button>
          {selected && !showPeople && <span>{selected.name}</span>}
        </div>
        {showPeople && <Assignee card={card} selected={selected} choose={setSelected} unavailable={close} />}
      </>}
      {!task && group.tasks.length > 0 && <label>Task position<select value={before} onChange={(event) => setBefore(event.target.value)}>
        <option value="">At the end</option>
        {group.tasks.map((item) => <option key={item.id} value={item.id}>Before {taskName(item)}</option>)}
      </select></label>}
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!valid || action.busy}>
        {task ? 'Save task' : linked ? 'Add linked task' : 'Create task'}
      </button>
    </form>
  </WorkspaceDialog>;
}

export function TaskMove({ group, groups, task, close }: { group: Checklist; groups: Checklist[]; task: Task; close: Close }) {
  const [destinationId, setDestination] = useState(group.id);
  const [before, setBefore] = useState('');
  const action = useChecklistMutation();
  const destination = groups.find(({ id }) => id === destinationId);
  const neighbors = destination?.tasks.filter(({ id }) => id !== task.id);
  function move(event: FormEvent) {
    event.preventDefault();
    if (!destination) return;
    const body = { toChecklistId: destination.id, beforeTaskId: before || null,
      sourceOrderVersion: group.orderVersion, destinationOrderVersion: destination.orderVersion };
    void action.run(['tasks.move', task.id, task.revision, body], (csrf, key) =>
      relationshipCommand('tasks.move', csrf, key, { id: task.id, revision: task.revision, body }), close);
  }
  return <WorkspaceDialog title="Move task" onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={move}>
      <label>Destination checklist<select value={destinationId} onChange={(event) => {
        setDestination(event.target.value); setBefore('');
      }} autoFocus>
        {groups.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>Task position<select value={before} onChange={(event) => setBefore(event.target.value)}>
        <option value="">At the end</option>
        {neighbors?.map((row) => <option key={row.id} value={row.id}>Before {taskName(row)}</option>)}
      </select></label>
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!destination || action.busy}>Place task</button>
    </form>
  </WorkspaceDialog>;
}
