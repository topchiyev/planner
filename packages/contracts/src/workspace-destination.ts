import { publicIdPattern, publicIdSchema } from './storage.js';

const uuid = publicIdPattern.slice(1, -1);
const project = new RegExp(`^/projects/${uuid}/?$`, 'u');
const board = new RegExp(`^/boards/${uuid}(?:/cards/${uuid})?/?$`, 'u');
const cursor = /^v1\.[A-Za-z0-9_-]{1,2045}$/u;
const workspaceParameters = {
  q: (value: string) => value.length <= 256,
  hidden: (value: string) => value === 'include' || value === 'only' || value === 'exclude',
  favorite: (value: string) => value === 'true' || value === 'false',
  cursor: (value: string) => cursor.test(value),
  favoriteCursor: (value: string) => cursor.test(value),
  open: (value: string) => publicIdSchema.safeParse(value).success,
};
const boardParameters = {
  context: (value: string) => value === 'board' || value === 'archive' || value === 'trash',
  view: (value: string) => value === 'kanban' || value === 'grid' || value === 'list',
};

export function workspaceReturnPath(value: unknown) {
  if (typeof value !== 'string' || value.length > 6_000 || !value.startsWith('/') || value.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const base = 'https://planner.invalid';
    const url = new URL(value, base);
    if (url.origin !== base) return null;
    const pathname = url.pathname.replace(/\/$/u, '');
    const allowed = pathname === '/workspace' ? workspaceParameters : board.test(pathname) ? boardParameters : null;
    if (!allowed && !project.test(pathname)) return null;
    const parameters = new URLSearchParams();
    for (const [field, valid] of Object.entries(allowed ?? {})) {
      const [input, ...duplicates] = url.searchParams.getAll(field);
      if (input !== undefined && !duplicates.length && valid(input)) parameters.set(field, input);
    }
    const query = parameters.toString();
    return pathname + (query ? '?' + query : '');
  } catch { return null; }
}

export function workspaceSignInPath(destination: unknown) {
  const path = workspaceReturnPath(destination);
  if (!path || path === '/workspace') return '/sign-in';
  return '/sign-in?' + new URLSearchParams({ returnTo: path });
}
