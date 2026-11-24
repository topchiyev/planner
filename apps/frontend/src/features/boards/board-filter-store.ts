import { boardRecipeSchema, type BoardFilterRecipe } from '@planner/contracts';

type StoredRecipes = { saved?: BoardFilterRecipe; lastCleared?: BoardFilterRecipe };

function parsedRecipe(value: unknown) {
  return boardRecipeSchema.safeParse(value).data;
}

export function readBoardRecipes(key: string): StoredRecipes {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    return { saved: parsedRecipe(saved?.saved), lastCleared: parsedRecipe(saved?.lastCleared) };
  } catch { return {}; }
}

export function saveBoardRecipes(key: string, value: StoredRecipes) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The browser may disable tab storage. */ }
}
