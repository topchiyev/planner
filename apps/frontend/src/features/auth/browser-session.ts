import { sessionSchema, workspaceSignInPath } from '@planner/contracts';
import { redirect, type LoaderFunctionArgs } from 'react-router';

export const sessionPath = '/api/v1/session';

export async function loadBrowserSession({ request }: LoaderFunctionArgs) {
  const response = await fetch(sessionPath, { cache: 'no-store', signal: request.signal });
  if (response.status === 401) {
    const url = new URL(request.url);
    throw redirect(workspaceSignInPath(url.pathname + url.search));
  }
  if (!response.ok) throw new Error('The browser session could not be verified.');
  return sessionSchema.parse(await response.json());
}
