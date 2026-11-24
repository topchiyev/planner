import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useRevalidator } from 'react-router';
import type { RelationshipCommandInput, WorkspaceReadOutput } from '@planner/contracts';
import { BoardCardPlacement, CardAppendTarget, DraggableBoardCard, MoveCardButton } from './card-placement-dnd.js';
import { ClearTrash, ListMaintenanceButtons } from '../lists/list-maintenance.js';
import { CardFrontCover } from '../media/card-cover.js';
import { FrontFields } from '../fields/workspace-fields.js';
import { FrontChecklists } from '../checklists/checklist-display.js';
import { DeleteList } from '../lists/delete-list.js';
import { BoardLists, ReadonlyBoardLists, type BoardList } from '../lists/board-lists.js';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog, useWorkspaceMutation } from '../projects/project-controls.js';
import { boardFilterLocation, hasBoardFilters } from '../workspace/board-filter-route.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import { anchorPage, type PlacementCard } from './card-placement.js';
import './board-cards.css';

type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
type CardPage = WorkspaceReadOutput<'boardCards'>;
type Card = CardPage['data'][number];
export type BoardCardContext = 'board' | 'archive' | 'trash';
export type BoardView = 'kanban' | 'grid' | 'list';

export const cardOpenerId = (id: string) => 'board-card-' + id;
const errors = new Map([
  ['CARD_ORDER_CONFLICT', 'The card order changed. Review the current list and try again.'],
  ['CARD_TYPE_RESTRICTED', 'This board does not allow the selected card type.'],
]);

function cardPath(boardId: string, cardId: string) {
  return `/boards/${boardId}/cards/${cardId}`;
}

export function BoardCards({ workspace, lists, context, view }: {
  workspace: Workspace; lists: BoardList[]; context: BoardCardContext; view: BoardView;
}) {
  const { pathname, search } = useLocation();
  const current = workspace.cardsPage;
  const revalidator = useRevalidator();
  const editable = context === 'board' && workspace.board.permissions.canEdit;
  if (!current) return <p className="workspace-problem" role="alert">
    Cards couldn’t load. <button className="workspace-button" type="button" disabled={revalidator.state !== 'idle'}
      onClick={() => void revalidator.revalidate()}>Retry</button>
  </p>;
  const kanban = view === 'kanban';
  const counts = new Map(current.counts.map(({ listId, count }) => [listId, count]));
  const listsById = new Map(lists.map((list) => [list.id, list]));
  const validation = current.searchValidation;
  const pageTo = (cursor: string | null) => ({ pathname, search: boardFilterLocation(search, workspace.recipe, cursor) });
  const trash = context === 'trash' ? lists.find(({ kind }) => kind === 'trash') : undefined;
  const display = kanban ? null : <FlatCards view={view} cards={current.data} lists={listsById}
    search={search} workspace={workspace} editable={editable} />;
  const contents = (list: BoardList) => <>
    {kanban && <ColumnCards cards={current.data.filter((card) => card.listId === list.id)}
      list={list} search={search} workspace={workspace} editable={editable} />}
    {editable && <ListCardActions workspace={workspace} list={list} />}
  </>;

  return <>
    {validation === 'invalid-pattern' ? <p role="status">Enter a valid slash-delimited search pattern.</p>
      : validation === 'search-limit' ? <p role="status">Search reached its scan limit. Narrow the filters and try again.</p>
        : !current.data.length && <p role="status">{hasBoardFilters(workspace.recipe) ? 'No matching cards' : 'No cards to show'}</p>}
    {trash && <ClearTrash workspace={workspace} trash={trash} />}
    {editable ? <BoardLists key={workspace.board.id} workspace={workspace} lists={lists} counts={counts} kanban={kanban} renderContents={contents}
      wrapDragContents={(children) => <BoardCardPlacement workspace={workspace} cards={current.data}>{children}{display}</BoardCardPlacement>} />
      : <>
        {(kanban || workspace.preferences.showCardCount) && <ReadonlyBoardLists lists={lists} counts={counts}
          showCount={workspace.preferences.showCardCount} kanban={kanban} renderContents={kanban ? contents : undefined} />}
        {display}
      </>}
    {(workspace.recipeCursor || current.page.nextCursor) && <nav aria-label="Card pages" className="workspace-pagination">
      {workspace.recipeCursor && <Link to={pageTo(null)}>First page</Link>}
      {current.page.nextCursor && <Link to={pageTo(current.page.nextCursor)}>Next page</Link>}
    </nav>}
  </>;
}

type Face = { card: Card; workspace: Workspace; search: string; list?: BoardList; showStatus?: boolean };
const ageFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function CardAge({ date }: { date: string }) {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86_400_000));
  return <time dateTime={date}>Created {ageFormat.format(days ? -days : 0, 'day')}</time>;
}

function CardFace({ card, workspace, search, list, showStatus = true }: Face) {
  const { showCreator, showCardAge } = workspace.preferences;
  return <div className="board-card-face">
    <CardFrontCover cover={card.cover} />
    <Link id={cardOpenerId(card.id)} to={{ pathname: cardPath(card.boardId, card.id), search }}>{card.name}</Link>
    {(list || (showStatus && card.closed) || (showCreator && card.creator) || showCardAge) &&
      <div className="board-card-meta">
        {list && <span>{list.name}</span>}{showStatus && card.closed && <span>Closed</span>}
        {showCreator && card.creator && <span>Created by {card.creator.name}</span>}
        {showCardAge && <CardAge date={card.createdAt} />}
      </div>}
    <FrontChecklists groups={card.frontChecklists} /><FrontFields fields={card.frontFields} />
  </div>;
}

function ColumnCards({ cards, list, workspace, search, editable }: {
  cards: Card[]; list: BoardList; workspace: Workspace; search: string; editable: boolean;
}) {
  return <>
    {cards.length > 0 && <ul className="board-cards" aria-label={'Cards in ' + list.name}>
      {cards.map((card) => {
        const face = <CardFace card={card} workspace={workspace} search={search} />;
        return editable ? <DraggableBoardCard card={card} key={card.id}>{face}</DraggableBoardCard> : <li key={card.id}>{face}</li>;
      })}
    </ul>}
    {editable && <CardAppendTarget listId={list.id} />}
  </>;
}

function FlatCards({ view, cards, lists, workspace, search, editable }: {
  view: Exclude<BoardView, 'kanban'>; cards: Card[]; lists: ReadonlyMap<string, BoardList>;
  workspace: Workspace; search: string; editable: boolean;
}) {
  if (!cards.length) return null;
  if (view === 'grid') return <ul className="board-card-grid" aria-label="Card grid">
    {cards.map((card) => <li key={card.id}>
      <CardFace card={card} workspace={workspace} search={search} list={lists.get(card.listId)} />
      {editable && <MoveCardButton card={card} />}
    </li>)}
  </ul>;
  return <div className="board-card-table-scroll" tabIndex={0} role="region" aria-label="Card list">
    <table className="board-card-table" aria-label="Cards">
      <thead><tr><th scope="col">Card</th><th scope="col">List</th><th scope="col">Status</th>
        {editable && <th scope="col">Actions</th>}</tr></thead>
      <tbody>{cards.map((card) => <tr key={card.id}>
        <td><CardFace card={card} workspace={workspace} search={search} showStatus={false} /></td>
        <td>{lists.get(card.listId)?.name}</td>
        <td>{card.closed ? 'Closed' : 'Open'}</td>
        {editable && <td><MoveCardButton card={card} /></td>}
      </tr>)}</tbody>
    </table>
  </div>;
}

function ListCardActions({ workspace, list }: { workspace: Workspace; list: BoardList }) {
  const [creating, setCreating] = useState(false);
  return <>
    <div className="project-actions board-list-card-actions">
      <button className="workspace-button board-add-card" type="button" aria-label={'Add card to ' + list.name}
        onClick={() => setCreating(true)}>Add card</button>
      <ListMaintenanceButtons workspace={workspace} list={list} />
      <DeleteList workspace={workspace} list={list} />
    </div>
    {creating && <CreateCardDialog workspace={workspace} list={list} close={() => setCreating(false)} />}
  </>;
}

function NewCardPosition({ boardId, listId, value, choose }: {
  boardId: string; listId: string; value: string; choose: (value: string) => void;
}) {
  const [page, setPage] = useState<{ cards: PlacementCard[]; cursor: string | null }>();
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const cursor = more ? page?.cursor ?? undefined : undefined;
    void anchorPage(boardId, listId, controller.signal, cursor).then((result) => {
      if (!controller.signal.aborted) {
        setPage((old) => ({ cards: cursor ? [...(old?.cards ?? []), ...result.data] : result.data, cursor: result.page.nextCursor }));
        setProblem(false);
      }
    }).catch(() => { if (!controller.signal.aborted) setProblem(true); });
    return () => controller.abort();
  }, [boardId, listId, attempt]);
  return <>
    {page?.cards.length ? <label>Position<select value={value} onChange={(event) => choose(event.target.value)}>
      <option value="">At the end</option>
      {page.cards.map((card) => <option key={card.id} value={card.id}>Before {card.name}</option>)}
    </select></label> : null}
    {page?.cursor && <button className="workspace-button" type="button" onClick={() => { setMore(true); setAttempt((next) => next + 1); }}>
      More positions
    </button>}
    {problem && <p role="alert">Positions couldn’t load. <button className="workspace-button" type="button"
      onClick={() => setAttempt((next) => next + 1)}>Retry</button></p>}
  </>;
}

function CreateCardDialog({ workspace, list, close }: {
  workspace: Workspace; list: BoardList; close: () => void;
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
      <NewCardPosition boardId={workspace.board.id} listId={list.id} value={beforeCardId} choose={setBeforeCardId} />
      {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={action.busy || !name.trim()}>Create card</button>
    </form>
  </WorkspaceDialog>;
}
