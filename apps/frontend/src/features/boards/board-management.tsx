import { useState, type FormEvent } from 'react';
import { type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import { useBoardMutation, useReturnFromBoard } from './board-actions.js';
import { BoardMembersDialog } from './board-members.js';

export type BoardWorkspace = WorkspaceReadOutput<'boardWorkspace'>['data'];
type Settings = Omit<BoardWorkspace['preferences'], 'revision'> & { name: string };
const booleans = [
  ['showCreator', 'Show card creator'], ['showCardAge', 'Show card age'], ['showCardCount', 'Show card count'],
  ['expandChecklists', 'Expand checklists'],
] as const;
const types = { project: 'Project', story: 'Story' } as const;

export function BoardManagement({ workspace }: { workspace: BoardWorkspace }) {
  const [dialog, setDialog] = useState<'settings' | 'members' | 'delete' | 'leave' | null>(null);
  const close = () => setDialog(null);
  const manage = workspace.board.permissions.canManage;
  const direct = workspace.selfMembership !== null;
  if (!manage && !direct) return null;
  return <div className="project-actions">
    {manage && <>
      <button type="button" className="workspace-button" onClick={() => setDialog('settings')}>Board settings</button>
      <button type="button" className="workspace-button" onClick={() => setDialog('members')}>Board members</button>
      <button type="button" className="workspace-button workspace-button-danger" onClick={() => setDialog('delete')}>Delete board</button>
    </>}
    {direct && <button type="button" className="workspace-button" onClick={() => setDialog('leave')}>Leave board</button>}
    {manage && dialog === 'settings' && <BoardSettingsDialog workspace={workspace} close={close} />}
    {manage && dialog === 'members' && <BoardMembersDialog board={workspace.board} close={close} />}
    {manage && dialog === 'delete' && <BoardDeleteDialog workspace={workspace} close={close} />}
    {direct && dialog === 'leave' && <BoardLeaveDialog workspace={workspace} close={close} />}
  </div>;
}

function BoardSettingsDialog({ workspace, close }: { workspace: BoardWorkspace; close: () => void }) {
  const action = useBoardMutation();
  const { board, preferences } = workspace;
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const current = { ...preferences, name: board.name };
  const effective = { ...current, ...draft };
  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));

  function update(event: FormEvent) {
    event.preventDefault();
    const changes = Object.fromEntries(Object.entries({ ...draft, ...(draft.name === undefined ? {} : { name: draft.name.trim() }) })
      .filter(([key, value]) => value !== current[key as keyof Settings]));
    if (!Object.keys(changes).length) return;
    void action.run(['boards.update', board.id, board.revision, changes], (csrf, key) =>
      relationshipCommand('boards.update', csrf, key, { id: board.id, revision: board.revision, body: changes }),
    () => setDraft({}));
  }

  return <WorkspaceDialog title="Board settings" onClose={close} busy={action.busy}>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <form className="project-form" onSubmit={update}>
      <label>Board name<input value={effective.name} maxLength={128} required onChange={(event) => patch('name', event.target.value)} /></label>
      <label>Default view<select value={effective.defaultView} onChange={(event) => patch('defaultView', event.target.value as Settings['defaultView'])}>
        <option value="kanban">Kanban</option><option value="grid">Grid</option><option value="list">List</option>
      </select></label>
      <label>Default card type<select value={effective.defaultCardType ?? ''} onChange={(event) => patch('defaultCardType',
        (event.target.value || null) as Settings['defaultCardType'])}>
        <option value="">No default</option>{Object.entries(types).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>Restrict card type<select value={effective.restrictedCardType ?? ''} onChange={(event) => patch('restrictedCardType',
        (event.target.value || null) as Settings['restrictedCardType'])}>
        <option value="">Both types</option>{Object.entries(types).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <fieldset className="board-option-set">
        <legend>Card display</legend>
        {booleans.map(([key, name]) => <label key={key} className="board-checkbox">
          <input type="checkbox" checked={effective[key]} onChange={(event) => patch(key, event.target.checked)} />{name}
        </label>)}
      </fieldset>
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy ||
        !effective.name.trim() || !Object.entries(draft).some(([key, value]) => value !== current[key as keyof Settings])}>Save board settings</button>
    </form>
  </WorkspaceDialog>;
}

function BoardDeleteDialog({ workspace, close }: { workspace: BoardWorkspace; close: () => void }) {
  const { board, project } = workspace;
  const [name, setName] = useState('');
  const action = useBoardMutation();
  const returnFromBoard = useReturnFromBoard();

  function remove(event: FormEvent) {
    event.preventDefault();
    if (name !== board.name) return;
    void action.run(['boards.delete', board.id, board.revision, name], (csrf, key) =>
      relationshipCommand('boards.delete', csrf, key, { id: board.id, revision: board.revision, body: { name } }),
    () => void returnFromBoard(project.id), false);
  }

  return <WorkspaceDialog title="Delete board" onClose={close} busy={action.busy}>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <form className="project-form" onSubmit={remove}>
      <p className="board-confirm-name">Type <strong>{board.name}</strong> to permanently delete this board and its contents.</p>
      <label>Exact board name<input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} required /></label>
      <button className="workspace-button workspace-button-danger" disabled={action.busy || name !== board.name} type="submit">Permanently delete board</button>
    </form>
  </WorkspaceDialog>;
}

function BoardLeaveDialog({ workspace, close }: { workspace: BoardWorkspace; close: () => void }) {
  const { board, project, selfMembership } = workspace;
  const action = useBoardMutation();
  const returnFromBoard = useReturnFromBoard();

  function leave() {
    const userId = action.actorId;
    if (!selfMembership || !userId) return;
    const { revision } = selfMembership;
    void action.run(['boards.removeMember', board.id, revision, userId], async (csrf, key) => {
      await relationshipCommand('boards.removeMember', csrf, key, { id: board.id, revision, userId });
      try {
        await readWorkspace('boardGet', board.id);
        return true;
      } catch (error) {
        if (error instanceof WorkspaceRequestError && error.status === 404) return false;
        throw error;
      }
    }, (retained) => {
      if (retained) close();
      else void returnFromBoard(project.id);
    });
  }

  return <WorkspaceDialog title="Leave board" onClose={close} busy={action.busy}>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <div className="project-confirm">
      <p>Leaving removes your follows and assignments on this board.</p>
      <div className="project-actions">
        <button className="workspace-button workspace-button-danger" type="button" disabled={action.busy} onClick={leave}>Confirm leave</button>
      </div>
    </div>
  </WorkspaceDialog>;
}
