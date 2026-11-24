import { boardFilterKeys, readBoardFilterRecipe, workspaceCardContext, writeBoardFilterRecipe, type BoardFilterRecipe } from '@planner/contracts';

export type BoardFilterContext = (typeof workspaceCardContext.options)[number];
export type { BoardFilterRecipe };

const cursorShape = /^v1\.[A-Za-z0-9_-]{1,2045}$/u;

export function readBoardFilterLocation(params: URLSearchParams) {
  const values = params.getAll('cursor');
  const cursor = values.length === 1 && cursorShape.test(values[0]) ? values[0] : null;
  return { recipe: readBoardFilterRecipe(params), cursor,
    context: workspaceCardContext.safeParse(params.get('context')).data ?? 'board' };
}

export function boardFilterApiQuery(context: BoardFilterContext, recipe: BoardFilterRecipe, cursor?: string | null) {
  const params = writeBoardFilterRecipe(new URLSearchParams({ context }), recipe);
  if (cursor) params.set('cursor', cursor);
  return params;
}

export function boardFilterLocation(search: string, recipe: BoardFilterRecipe, cursor?: string | null) {
  const params = writeBoardFilterRecipe(new URLSearchParams(search), recipe);
  params.delete('cursor');
  if (cursor) params.set('cursor', cursor);
  return params.size ? '?' + params : '';
}

export function hasBoardFilters(recipe: BoardFilterRecipe) {
  return !!recipe.q || recipe.unassigned || boardFilterKeys.some((key) => recipe[key].length > 0);
}

export const emptyBoardRecipe = () => readBoardFilterRecipe(new URLSearchParams());
