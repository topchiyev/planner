import { createContext, useCallback, useContext } from 'react';
import { useRevalidator } from 'react-router';

export const BoardRefreshContext = createContext<(() => void) | null>(null);

export function useBoardRefresh() {
  const refresh = useContext(BoardRefreshContext);
  const revalidator = useRevalidator();
  return useCallback(() => {
    if (refresh) refresh();
    else void revalidator.revalidate();
  }, [refresh, revalidator]);
}
