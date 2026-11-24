import { useEffect, useState, type FormEvent } from 'react';
import { useRevalidator } from 'react-router';
import { type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import { useEligibleMemberPage } from './eligible-member-page.js';
import { LabelChip, labelName, PersonalFollow, useAffiliationMutation } from './affiliation-ui.js';

type Card = WorkspaceReadOutput<'cardGet'>['data'];
type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
type LinkOperation = 'cards.addLabel' | 'cards.removeLabel' | 'cards.assign' | 'cards.unassign';

export function CardAffiliationControls({ card, workspace }: { card: Card; workspace: Workspace }) {
  const action = useAffiliationMutation();
  const [dialog, setDialog] = useState<'labels' | 'people'>();
  const editable = card.permissions.canEdit;
  const attached = new Set(card.labels.map(({ id }) => id));
  const availableLabels = workspace.labels.filter(({ id }) => !attached.has(id));

  function link(operation: LinkOperation, relatedId: string) {
    const { id, revision } = card;
    void action.run([operation, id, revision, relatedId], (csrf, key) =>
      relationshipCommand(operation, csrf, key, { id, relatedId, revision }), () => {
      if (operation === 'cards.addLabel' || operation === 'cards.assign') setDialog(undefined);
    });
  }

  return <section className="card-affiliations" aria-label="Card affiliations">
    {card.permissions.canFollow && <PersonalFollow resource="card" id={card.id} revision={card.revision}
      following={card.following} automatic={card.automaticFollow} />}
    {!dialog && action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
    <div>
      <h3>Labels</h3>
      {card.labels.length > 0 && <ul aria-label="Attached labels" className="card-affiliation-items">
        {card.labels.map((label) => <li key={label.id}>
          <LabelChip label={label} />
          {editable && <button className="workspace-button" type="button" disabled={action.busy}
            aria-label={'Remove label ' + labelName(label)} onClick={() => link('cards.removeLabel', label.id)}>Remove</button>}
        </li>)}
      </ul>}
      {editable && availableLabels.length > 0 && <button className="workspace-button" type="button"
        disabled={action.busy} onClick={() => { action.clearProblem(); setDialog('labels'); }}>Add label</button>}
    </div>
    <div>
      <h3>Assignees</h3>
      {card.assignees.length > 0 && <ul aria-label="Assignees" className="card-affiliation-items">
        {card.assignees.map((person) => <li key={person.id}>
          <span>{person.name}</span>
          {editable && <button className="workspace-button" type="button" disabled={action.busy}
            aria-label={'Unassign ' + person.name} onClick={() => link('cards.unassign', person.id)}>Unassign</button>}
        </li>)}
      </ul>}
      {editable && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => { action.clearProblem(); setDialog('people'); }}>Assign people</button>}
    </div>
    {editable && dialog === 'labels' && <WorkspaceDialog title="Add label" busy={action.busy} onClose={() => setDialog(undefined)}>
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      {availableLabels.length ? <ul className="board-palette" aria-label="Available labels">{availableLabels.map((label) => <li key={label.id}>
        <LabelChip label={label} />
        <button className="workspace-button" type="button" disabled={action.busy}
          aria-label={'Add label ' + labelName(label)} onClick={() => link('cards.addLabel', label.id)}>Add</button>
      </li>)}</ul> : <p>No other labels are available.</p>}
    </WorkspaceDialog>}
    {editable && dialog === 'people' && <AssignPeople card={card} busy={action.busy} problem={action.problem}
      close={() => setDialog(undefined)} assign={(id) => link('cards.assign', id)} />}
  </section>;
}

function AssignPeople({ card, busy, problem, close, assign }: {
  card: Card; busy: boolean; problem: string; close: () => void; assign: (id: string) => void;
}) {
  const members = useEligibleMemberPage(card.boardId, card.revision);
  const revalidator = useRevalidator();
  const { accessLost, result: visible, cursor, setCursor } = members;
  useEffect(() => {
    if (accessLost) {
      close();
      void revalidator.revalidate();
    }
  }, [accessLost, close, revalidator]);

  function searchMembers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    members.search(String(new FormData(event.currentTarget).get('member') ?? ''));
  }
  const assigned = new Set(card.assignees.map(({ id }) => id));
  const people = visible?.page?.data.filter(({ id }) => !assigned.has(id));
  return <WorkspaceDialog title="Assign people" busy={busy} onClose={close}>
    {problem && <p role="alert" className="workspace-problem">{problem}</p>}
    <form className="project-form" role="search" method="post" onSubmit={searchMembers}>
      <label>Find a board member<input type="search" name="member" maxLength={120} /></label>
      <button className="workspace-button" type="submit" disabled={busy}>Search members</button>
    </form>
    {!visible ? <p role="status">Loading board members…</p> : !visible.page ? <p role="alert">
      Board members couldn’t load. <button className="workspace-button" type="button" onClick={members.retry}>Retry</button>
    </p> : <>
      {people?.length ? <ul className="board-palette" aria-label="Eligible board members">{people.map((person) => <li key={person.id}>
        <span>{person.name}{person.username && <small className="affiliation-username">{person.username}</small>}</span>
        <button className="workspace-button" type="button" disabled={busy}
          aria-label={'Assign ' + person.name} onClick={() => assign(person.id)}>Assign</button>
      </li>)}</ul> : <p>No eligible board members on this page.</p>}
      <div className="project-actions">
        {cursor && <button type="button" className="workspace-button" disabled={busy} onClick={() => setCursor(undefined)}>First page</button>}
        {visible.page.page.nextCursor && <button type="button" className="workspace-button" disabled={busy}
          onClick={() => setCursor(visible.page?.page.nextCursor ?? undefined)}>Next page</button>}
      </div>
    </>}
  </WorkspaceDialog>;
}
