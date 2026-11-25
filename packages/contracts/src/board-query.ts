import { z } from 'zod';
import { publicIdSchema } from './storage.js';

export const boardFilterKeys = ['labelsAny', 'labelsNone', 'members', 'listIds'] as const;
export const maximumBoardFilterIds = 50;
export const boardSearchQuery = z.string().trim().max(256);
export const boardPageSize = z.string().regex(/^[1-9]\d{0,8}$/u).transform((value) => Math.min(Number(value), 100));
export const boardFilterIds = z.array(publicIdSchema).max(maximumBoardFilterIds).transform((ids) => [...new Set(ids)].sort());
export const boardQueryIds = z.union([publicIdSchema, z.array(publicIdSchema).max(maximumBoardFilterIds)])
  .transform((value) => boardFilterIds.parse(typeof value === 'string' ? [value] : value));
export const boardRecipeSchema = z.strictObject({
  q: boardSearchQuery, labelsAny: boardFilterIds, labelsNone: boardFilterIds, members: boardFilterIds, listIds: boardFilterIds,
  unassigned: z.boolean(), limit: z.number().int().min(1).max(100),
});
export type BoardFilterRecipe = z.infer<typeof boardRecipeSchema>;

function single(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

export function readBoardFilterRecipe(params: URLSearchParams): BoardFilterRecipe {
  const groups = {} as Pick<BoardFilterRecipe, typeof boardFilterKeys[number]>;
  for (const key of boardFilterKeys) groups[key] = boardFilterIds.safeParse(params.getAll(key)).data ?? [];
  return {
    ...groups, q: boardSearchQuery.safeParse(single(params, 'q')).data ?? '',
    unassigned: single(params, 'unassigned') === 'true',
    limit: boardPageSize.safeParse(single(params, 'limit')).data ?? 25,
  };
}

export function writeBoardFilterRecipe(params: URLSearchParams, value: BoardFilterRecipe) {
  const recipe = boardRecipeSchema.parse(value);
  for (const key of [...boardFilterKeys, 'q', 'unassigned', 'limit']) params.delete(key);
  if (recipe.q) params.set('q', recipe.q);
  for (const key of boardFilterKeys) for (const id of recipe[key]) params.append(key, id);
  if (recipe.unassigned) params.set('unassigned', 'true');
  if (recipe.limit !== 25) params.set('limit', String(recipe.limit));
  return params;
}
