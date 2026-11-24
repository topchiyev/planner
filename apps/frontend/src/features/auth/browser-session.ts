import { passiveSessionHeader, sessionSchema, workspaceSignInPath } from '@planner/contracts';
import { redirect, type LoaderFunctionArgs } from 'react-router';

export const sessionPath = '/api/v1/session';

export async function readBrowserSession(signal: AbortSignal, activity: 'active' | 'passive') {
  const response = await fetch(sessionPath, { cache: 'no-store', signal,
    headers: activity === 'passive' ? { [passiveSessionHeader]: '1' } : undefined,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('The browser session could not be verified.');
  return sessionSchema.parse(await response.json());
}

let passiveDestination: { url: string } | undefined;

export async function replaceBrowserLocationPassively(destination: string, replace: () => void | Promise<void>) {
  const pending = { url: new URL(destination, window.location.origin).href };
  passiveDestination = pending;
  try { await replace(); }
  finally { if (passiveDestination === pending) passiveDestination = undefined; }
}

export async function loadBrowserSession({ request }: LoaderFunctionArgs) {
  const activity = request.url === passiveDestination?.url ? 'passive' : 'active';
  const session = await readBrowserSession(request.signal, activity);
  if (session) return session;
  const url = new URL(request.url);
  throw redirect(workspaceSignInPath(url.pathname + url.search));
}
