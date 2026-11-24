import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useRevalidator } from 'react-router';
import type { RelationshipCommandInput, WorkspaceReadOutput } from '@planner/contracts';
import { BoardCardPlacement, CardAppendTarget, DraggableBoardCard } from './card-placement-dnd.js';
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
  const current = workspace.cardsPage;
  const revalidator = useRevalidator();
  const editable = context === 'board' && workspace.board.permissions.canEdit;
  if (!current) return <p className="workspace-problem" role="alert">
    Cards couldn’t load. <button className="workspace-button" type="button" disabled={revalidator.state !== 'idle'}
      onClick={() => void revalidator.revalidate()}>Retry</button>
  </p>;
  const counts = new Map(current.counts.map(({ listId, count }) => [listId, count]));
  const renderContents = (list: BoardList) => <CardsInList workspace={workspace} list={list} editable={editable}
    cards={current.data.filter((card) => card.listId === list.id)} search={search} />;
  const trash = context === 'trash' ? lists.find(({ kind }) => kind === 'trash') : undefined;
  const validation = current.searchValidation;
  const pageTo = (cursor: string | null) => ({ pathname, search: boardFilterLocation(search, workspace.recipe, cursor) });
  return <>
    {validation === 'invalid-pattern' ? <p role="status">Enter a valid slash-delimited search pattern.</p>
      : validation === 'search-limit' ? <p role="status">Search reached its scan limit. Narrow the filters and try again.</p>
        : !current.data.length && <p role="status">{hasBoardFilters(workspace.recipe) ? 'No matching cards' : 'No cards to show'}</p>}
    {trash && <ClearTrash workspace={workspace} trash={trash} />}
    {editable ? <BoardLists key={workspace.board.id} workspace={workspace} lists={lists} counts={counts} renderContents={renderContents}
      wrapDragContents={(children) => <BoardCardPlacement workspace={workspace} cards={current.data}>{children}</BoardCardPlacement>} /> :
      <ReadonlyBoardLists lists={lists} counts={counts} renderContents={renderContents} />}
    {(workspace.recipeCursor || current.page.nextCursor) && <nav aria-label="Card pages" className="workspace-pagination">
      {workspace.recipeCursor && <Link to={pageTo(null)}>First page</Link>}
      {current.page.nextCursor && <Link to={pageTo(current.page.nextCursor)}>Next page</Link>}
    </nav>}
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
          {card.closed && <span>Closed</span>}<CardFrontCover cover={card.cover} /><FrontChecklists groups={card.frontChecklists} /><FrontFields fields={card.frontFields} /></>;
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
