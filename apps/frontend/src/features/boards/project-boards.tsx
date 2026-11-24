import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../app/page-state.js';
import { relationshipCommand } from '../projects/project-api.js';
import type { loadNativeProject } from '../workspace/workspace-loaders.js';
import { boardHref, BoardLinks } from '../workspace/workspace-navigation.js';
import { useBoardMutation } from './board-actions.js';

type Project = NonNullable<Awaited<ReturnType<typeof loadNativeProject>>>;

export function ProjectBoards({ project }: { project: Project }) {
  const action = useBoardMutation();
  const [name, setName] = useState('');
  const anchorLinks = useRef(new Map<string, HTMLAnchorElement>());
  const boards = project.boards;

  function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void action.run(['boards.create', project.id, project.revision, trimmed], (csrf, key) =>
      relationshipCommand('boards.create', csrf, key, {
        id: project.id, revision: project.revision, body: { name: trimmed },
      }), () => setName(''));
  }

  function move(index: number, direction: -1 | 1) {
    const { id, revision } = boards[index];
    const beforeBoardId = direction === -1 ? boards[index - 1].id : boards[index + 2]?.id ?? null;
    const projectBoardOrderVersion = project.boardOrderVersion;
    void action.run(['boards.move', id, revision, beforeBoardId, projectBoardOrderVersion], (csrf, key) =>
      relationshipCommand('boards.move', csrf, key, { id, revision, body: { beforeBoardId, projectBoardOrderVersion } }),
    () => anchorLinks.current.get(id)?.focus());
  }

  return <section aria-label="Boards" className="workspace-detail">
    <h2>Boards</h2>
    {project.permissions.canCreateBoard && <form className="board-create project-form" onSubmit={create}>
      <label>Board name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required /></label>
      <button className="workspace-button workspace-button-primary" type="submit" disabled={action.busy || !name.trim()}>Create board</button>
    </form>}
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {boards.length ? project.permissions.canCreateBoard ? <ol className="workspace-board-order" aria-label="Board order">
      {boards.map(({ id, name }, index) => <li key={id}>
        <Link to={boardHref(id)} ref={(element) => { if (element) anchorLinks.current.set(id, element); else anchorLinks.current.delete(id); }}>{name}</Link>
        <div className="project-actions">
          <button type="button" className="workspace-button" disabled={action.busy || index === 0}
            aria-label={`Move ${name} up`} onClick={() => move(index, -1)}>Move up</button>
          <button type="button" className="workspace-button" disabled={action.busy || index === boards.length - 1}
            aria-label={`Move ${name} down`} onClick={() => move(index, 1)}>Move down</button>
        </div>
      </li>)}
    </ol> : <BoardLinks boards={boards} /> : <EmptyState title="No boards to show" />}
  </section>;
}
