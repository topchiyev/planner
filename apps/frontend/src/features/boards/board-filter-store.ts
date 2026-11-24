import { boardRecipeSchema, type BoardFilterRecipe } from '@planner/contracts';

export const boardRecipeStoragePrefix = 'planner.boardFilters.v1/';
export const maximumSavedBoardRecipes = 20;
export const maximumBoardRecipeNameLength = 64;
type NamedRecipe = { name: string; recipe: BoardFilterRecipe };
type StoredRecipes = { saved: NamedRecipe[]; lastCleared?: BoardFilterRecipe };

function parsedRecipe(value: unknown) {
  return boardRecipeSchema.safeParse(value).data;
}

export function readBoardRecipes(key: string): StoredRecipes {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { saved: [] };
    const stored = JSON.parse(raw);
    const saved: NamedRecipe[] = [];
    if (Array.isArray(stored?.saved)) for (const entry of stored.saved.slice(0, maximumSavedBoardRecipes)) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const recipe = parsedRecipe(entry?.recipe);
      if (name && name.length <= maximumBoardRecipeNameLength && recipe && !saved.some((item) => item.name === name)) {
        saved.push({ name, recipe });
      }
    }
    return { saved, lastCleared: parsedRecipe(stored?.lastCleared) };
  } catch { return { saved: [] }; }
}

export function saveBoardRecipes(key: string, value: StoredRecipes) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The browser may disable tab storage. */ }
}

export function clearBoardRecipes() {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(boardRecipeStoragePrefix)) sessionStorage.removeItem(key);
    }
  } catch { /* The browser may disable tab storage. */ }
}

export function readBoardView(key: string) {
  try { return sessionStorage.getItem(boardRecipeStoragePrefix + 'view/' + key); }
  catch { return null; }
}

export function saveBoardView(key: string, view: string) {
  try { sessionStorage.setItem(boardRecipeStoragePrefix + 'view/' + key, view); }
  catch { /* The browser may disable tab storage. */ }
}
