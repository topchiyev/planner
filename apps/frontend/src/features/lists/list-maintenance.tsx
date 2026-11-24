import { useState, type FormEvent } from 'react';
import { type RelationshipCommandInput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog, useWorkspaceMutation } from '../projects/project-controls.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import type { BoardList } from './board-lists.js';

type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
type Sort = Pick<RelationshipCommandInput<'lists.sort'>, 'field' | 'direction'>;
const errors = new Map([
  ['CARD_ORDER_CONFLICT', 'The cards changed. Review the current list and try again.'],
  ['ARCHIVE_CARDS_SOURCE', 'Choose a closed list to archive its cards.'],
  ['TRASH_CLEAR_DATA_LIMIT', 'This trash contains imported data too large to preserve while clearing it.'],
]);

function useMaintenanceAction() {
  return useWorkspaceMutation(errors, 'The cards or your access changed. Review the current information and try again.');
}

export function ListMaintenanceButtons({ workspace, list }: { workspace: Workspace; list: BoardList }) {
  const [dialog, setDialog] = useState<'sort' | 'archive' | null>(null);
  const close = () => setDialog(null);
  const archive = workspace.lists.find(({ kind }) => kind === 'archive');
  return <>
    <button type="button" className="workspace-button" onClick={() => setDialog('sort')}
      aria-label={'Sort cards in ' + list.name} disabled={list.cardCount < 2}>Sort cards</button>
    {list.kind === 'closed' && archive && <button type="button" className="workspace-button"
      aria-label={'Archive cards in ' + list.name} disabled={!list.cardCount} onClick={() => setDialog('archive')}>Archive cards</button>}
    {dialog === 'sort' && <SortCards list={list} close={close} />}
    {dialog === 'archive' && archive && <ArchiveCards list={list} archive={archive} close={close} />}
  </>;
}

function SortCards({ list, close }: { list: BoardList; close: () => void }) {
  const [field, setField] = useState<Sort['field']>('name');
  const [direction, setDirection] = useState<Sort['direction']>('asc');
  const action = useMaintenanceAction();

  function sort(event: FormEvent) {
    event.preventDefault();
    const body = { field, direction, sourceOrderVersion: list.orderVersion };
    void action.run(['lists.sort', list.id, list.revision, body], (csrf, key) =>
      relationshipCommand('lists.sort', csrf, key, { id: list.id, revision: list.revision, body }), close);
  }

  return <WorkspaceDialog title="Sort cards" onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={sort}>
      <label>Sort by<select value={field} onChange={(event) => setField(event.target.value as Sort['field'])}>
        <option value="name">Name</option><option value="dueDate">Due date</option><option value="createdAt">Creation date</option>
      </select></label>
      <label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as Sort['direction'])}>
        <option value="asc">Ascending</option><option value="desc">Descending</option>
      </select></label>
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy || list.cardCount < 2}>Apply sort</button>
    </form>
  </WorkspaceDialog>;
}

function ArchiveCards({ list, archive, close }: { list: BoardList; archive: BoardList; close: () => void }) {
  const action = useMaintenanceAction();

  function move(event: FormEvent) {
    event.preventDefault();
    const body = { sourceOrderVersion: list.orderVersion, archiveListId: archive.id, destinationOrderVersion: archive.orderVersion };
    void action.run(['lists.archiveCards', list.id, list.revision, body], (csrf, key) =>
      relationshipCommand('lists.archiveCards', csrf, key, { id: list.id, revision: list.revision, body }), close);
  }

  return <WorkspaceDialog title="Archive cards" onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={move}>
      <p>Move {list.cardCount} {list.cardCount === 1 ? 'card' : 'cards'} from <strong>{list.name}</strong> to Archive?</p>
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-primary" disabled={action.busy || !list.cardCount}>Confirm archive</button>
    </form>
  </WorkspaceDialog>;
}

export function ClearTrash({ workspace, trash }: { workspace: Workspace; trash: BoardList }) {
  const [open, setOpen] = useState(false);
  if (!workspace.board.permissions.canClearTrash) return null;
  return <>
    <button type="button" className="workspace-button workspace-button-danger" disabled={!trash.cardCount}
      onClick={() => setOpen(true)}>Clear trash</button>
    {open && <ClearTrashDialog boardId={workspace.board.id} trash={trash} close={() => setOpen(false)} />}
  </>;
}

function ClearTrashDialog({ boardId, trash, close }: { boardId: string; trash: BoardList; close: () => void }) {
  const [confirmed, setConfirmed] = useState<{ revision: number; orderVersion: number } | null>(null);
  const action = useMaintenanceAction();
  const matches = confirmed?.revision === trash.revision && confirmed.orderVersion === trash.orderVersion;

  function clear(event: FormEvent) {
    event.preventDefault();
    if (!matches || !trash.cardCount) return;
    const body = { trashListId: trash.id, trashOrderVersion: trash.orderVersion, confirmed: true };
    setConfirmed(null);
    void action.run(['lists.clearTrash', boardId, trash.revision, body], (csrf, key) =>
      relationshipCommand('lists.clearTrash', csrf, key, { id: boardId, revision: trash.revision, body }), close);
  }

  return <WorkspaceDialog title="Clear trash" onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={clear}>
      <p>Permanently delete {trash.cardCount} {trash.cardCount === 1 ? 'card' : 'cards'} and their contents?</p>
      <label className="board-checkbox"><input type="checkbox" checked={matches} disabled={action.busy || !trash.cardCount}
        onChange={(event) => setConfirmed(event.target.checked ? { revision: trash.revision, orderVersion: trash.orderVersion } : null)} />
        I confirm permanent deletion of these cards
      </label>
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      <button type="submit" className="workspace-button workspace-button-danger" disabled={action.busy || !matches || !trash.cardCount}>
        Permanently clear trash
      </button>
    </form>
  </WorkspaceDialog>;
}
