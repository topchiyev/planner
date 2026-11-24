import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { maximumBoardFilterIds, type BoardFilterRecipe } from '@planner/contracts';
import type { BoardList } from '../lists/board-lists.js';
import { boardFilterLocation, emptyBoardRecipe, hasBoardFilters } from '../workspace/board-filter-route.js';
import type { loadNativeBoard } from '../workspace/workspace-loaders.js';
import { BoardFilterMembers } from './board-filter-members.js';
import { readBoardRecipes, saveBoardRecipes } from './board-filter-store.js';
import './board-filters.css';

type Workspace = NonNullable<Awaited<ReturnType<typeof loadNativeBoard>>>;
type IdFilter = 'labelsAny' | 'labelsNone' | 'members' | 'listIds';

export function BoardFilters({ workspace, lists, loading, onAccessLost }: {
  workspace: Workspace; lists: BoardList[]; loading: boolean; onAccessLost: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const key = 'planner.boardFilters.v1/' + workspace.recipeScope + '/' + workspace.board.id + '/' + workspace.context;
  const [recipes, setRecipes] = useState(() => readBoardRecipes(key));
  const [draft, setDraft] = useState(workspace.recipe);
  const [advanced, setAdvanced] = useState(false);
  const [message, setMessage] = useState('');

  function input(filter: IdFilter, id: string, name: string) {
    const selected = draft[filter].includes(id);
    return <label className="board-filter-choice" key={id}><input type="checkbox" checked={selected}
      disabled={!selected && draft[filter].length >= maximumBoardFilterIds}
      onChange={() => setDraft((current) => ({ ...current, [filter]: selected
        ? current[filter].filter((value) => value !== id) : [...current[filter], id] }))} />{name}</label>;
  }
  function apply(recipe: BoardFilterRecipe) {
    setDraft(recipe);
    return navigate({ pathname: location.pathname, search: boardFilterLocation(location.search, recipe) });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void apply(draft);
  }
  function save() {
    const current = { ...recipes, saved: draft };
    saveBoardRecipes(key, current);
    setRecipes(current);
    setMessage('Filters saved for this tab.');
  }
  function clear() {
    const current = { ...recipes, lastCleared: hasBoardFilters(workspace.recipe) ? workspace.recipe : draft };
    saveBoardRecipes(key, current);
    setRecipes(current);
    void apply(emptyBoardRecipe());
  }

  return <form className="board-filter-form" role="search" aria-label="Board cards" method="get" onSubmit={submit}>
    <div className="board-filter-actions">
      <label>Search cards<input type="search" name="q" maxLength={256} value={draft.q}
        onChange={(event) => setDraft({ ...draft, q: event.target.value })} /></label>
      <button className="workspace-button workspace-button-primary" type="submit">Apply filters</button>
      {hasBoardFilters(draft) || hasBoardFilters(workspace.recipe) ? <>
        <button className="workspace-button" type="button" onClick={clear}>Clear filters</button>
        <button className="workspace-button" type="button" onClick={save}>Save filters</button>
      </> : null}
    </div>
    <details className="board-filter-details" onToggle={(event) => setAdvanced(event.currentTarget.open)}>
      <summary>Filter by labels, members or lists</summary>
      <div className="board-filter-sets">
        {workspace.labels.length > 0 && <>
          <fieldset className="board-filter-group"><legend>Include any label</legend>
            {workspace.labels.map(({ id, name, color }) => input('labelsAny', id, name ?? ('Unnamed label' + (color ? ' (' + color + ')' : ''))))}
          </fieldset>
          <fieldset className="board-filter-group"><legend>Exclude labels</legend>
            {workspace.labels.map(({ id, name, color }) => input('labelsNone', id, name ?? ('Unnamed label' + (color ? ' (' + color + ')' : ''))))}
          </fieldset>
        </>}
        {advanced && <BoardFilterMembers key={workspace.board.revision} boardId={workspace.board.id} revision={workspace.board.revision}
          onAccessLost={onAccessLost}>{({ id, name }) => input('members', id, name)}</BoardFilterMembers>}
        {lists.length > 0 && <fieldset className="board-filter-group"><legend>Lists</legend>
          {lists.map(({ id, name }) => input('listIds', id, name))}
        </fieldset>}
      </div>
      <label className="board-filter-choice"><input type="checkbox" checked={draft.unassigned}
        onChange={(event) => setDraft({ ...draft, unassigned: event.target.checked })} />Unassigned cards</label>
    </details>
    <div className="board-filter-actions">
      {recipes.saved && <button className="workspace-button" type="button" onClick={() => void apply(recipes.saved!)}>Recall saved filters</button>}
      {recipes.lastCleared && <button className="workspace-button" type="button" onClick={() => void apply(recipes.lastCleared!)}>Recall last cleared filters</button>}
    </div>
    {(loading || message) && <p role="status">{loading ? 'Loading cards…' : message}</p>}
  </form>;
}
