import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { workspaceSignInPath, type RelationshipCommandInput, type WorkspaceReadOutput } from '@planner/contracts';
import { BoardCardPlacement, CardAppendTarget, DraggableBoardCard } from './card-placement-dnd.js';
import { ClearTrash, ListMaintenanceButtons } from '../lists/list-maintenance.js';
import { FrontChecklists } from '../checklists/checklist-display.js';
import { DeleteList } from '../lists/delete-list.js';
import { BoardLists, ReadonlyBoardLists, type BoardList } from '../lists/board-lists.js';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog, useWorkspaceMutation } from '../projects/project-controls.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import './board-cards.css';

type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
type CardPage = WorkspaceReadOutput<'boardCards'>;
type Card = CardPage['data'][number];
export type BoardCardContext = 'board' | 'archive' | 'trash';
const errors = new Map([
  ['CARD_ORDER_CONFLICT', 'The card order changed. Review the current list and try again.'],
  ['CARD_TYPE_RESTRICTED', 'This board does not allow the selected card type.'],
]);

function cardPath(boardId: string, cardId: string) {
  return `/boards/${boardId}/cards/${cardId}`;
}

export function BoardCards({ workspace, lists, context }: { workspace: Workspace; lists: BoardList[]; context: BoardCardContext }) {
  const { pathname, search } = useLocation();
  const first = workspace.cardsPage;
  const [more, setMore] = useState<{ first: CardPage; page: CardPage }>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const current = more?.first === first ? more.page : first;
  const editable = context === 'board' && workspace.board.permissions.canEdit;
  const renderContents = (list: BoardList) => <CardsInList workspace={workspace} list={list} editable={editable}
    cards={current.data.filter((card) => card.listId === list.id)} search={search} />;

  async function loadMore() {
    const cursor = current.page.nextCursor;
    if (pending.current || !cursor) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setProblem('');
    try {
      const next = await readWorkspace('boardCards', workspace.board.id, new URLSearchParams({ context, cursor }), controller.signal);
      if (controller.signal.aborted) return;
      const cards = new Map(current.data.map((card) => [card.id, card]));
      for (const card of next.data) cards.set(card.id, card);
      setMore({ first, page: { ...next, data: [...cards.values()] } });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) window.location.replace(workspaceSignInPath(pathname + search));
      else setProblem('More cards couldn’t load.');
    } finally { pending.current = null; if (!controller.signal.aborted) setLoading(false); }
  }

  const trash = context === 'trash' ? lists.find(({ kind }) => kind === 'trash') : undefined;
  return <>
    {trash && <ClearTrash workspace={workspace} trash={trash} />}
    {editable ? <BoardLists key={workspace.board.id} workspace={workspace} lists={lists} renderContents={renderContents}
      wrapDragContents={(children) => <BoardCardPlacement workspace={workspace} cards={current.data}>{children}</BoardCardPlacement>} /> :
      <ReadonlyBoardLists lists={lists} renderContents={renderContents} />}
    {problem && <p className="workspace-problem" role="alert">{problem}</p>}
    {current.page.nextCursor && <button className="workspace-button" type="button" disabled={loading} onClick={() => void loadMore()}>Load more cards</button>}
  </>;
}

function CardsInList({ workspace, list, cards, editable, search }: {
  workspace: Workspace; list: BoardList; cards: Card[]; editable: boolean; search: string;
}) {
  const [creating, setCreating] = useState(false);
  return <>
    {cards.length > 0 && <ul className="board-cards" aria-label={'Cards in ' + list.name}>
      {cards.map((card) => {
        const content = <><Link to={{ pathname: cardPath(card.boardId, card.id), search }}>{card.name}</Link>
          {card.closed && <span>Closed</span>}<FrontChecklists groups={card.frontChecklists} /></>;
        return editable ? <DraggableBoardCard card={card} key={card.id}>{content}</DraggableBoardCard> : <li key={card.id}>{content}</li>;
      })}
    </ul>}
    {editable && <CardAppendTarget listId={list.id} />}
    {editable && <div className="project-actions">
      <button className="workspace-button board-add-card" type="button" aria-label={'Add card to ' + list.name}
        onClick={() => setCreating(true)}>Add card</button>
      <ListMaintenanceButtons workspace={workspace} list={list} />
      <DeleteList workspace={workspace} list={list} />
    </div>}
    {editable && creating && <CreateCardDialog workspace={workspace} list={list} cards={cards} close={() => setCreating(false)} />}
  </>;
}

function CreateCardDialog({ workspace, list, cards, close }: {
  workspace: Workspace; list: BoardList; cards: Card[]; close: () => void;
}) {
  const action = useWorkspaceMutation(errors, 'This list or your access changed. Review the current information and try again.',
    'Check the card name and type.');
  const navigate = useNavigate();
  const { search } = useLocation();
  const restriction = workspace.preferences.restrictedCardType;
  const [name, setName] = useState('');
  const [type, setType] = useState<'' | 'project' | 'story'>('');
  const [beforeCardId, setBeforeCardId] = useState('');

  function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const body: Omit<RelationshipCommandInput<'cards.create'>, 'id' | 'expectedRevision'> = {
      name: name.trim(), description: null, beforeCardId: beforeCardId || null, ...(type && !restriction && { type }),
    };
    void action.run(['cards.create', list.id, list.revision, body], (csrf, key) =>
      relationshipCommand('cards.create', csrf, key, { id: list.id, revision: list.revision, body }), async (result) => {
        if (!result) return;
        close();
        await navigate({ pathname: cardPath(workspace.board.id, result.data.card.id), search });
      }, false);
  }

  return <WorkspaceDialog title="Add card" onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={create}>
      <label>Card name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required autoFocus /></label>
      <label>Card type<select value={restriction ? '' : type} onChange={(event) => setType(event.target.value as typeof type)}>
        <option value="">{restriction === 'story' ? 'Story' : restriction === 'project' ? 'Project' : 'Board default'}</option>
        {!restriction && <><option value="project">Project</option><option value="story">Story</option></>}
      </select></label>
      {cards.length > 0 && <label>Position<select value={beforeCardId} onChange={(event) => setBeforeCardId(event.target.value)}>
        <option value="">At the end</option>
        {cards.map((card) => <option key={card.id} value={card.id}>Before {card.name}</option>)}
      </select></label>}
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={action.busy || !name.trim()}>Create card</button>
    </form>
  </WorkspaceDialog>;
}
