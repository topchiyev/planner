import {
  accountPreferencesSchema, relationshipCommands, workspaceOperations, workspaceSignInPath,
  type WorkspaceReadOperation, type WorkspaceReadOutput,
} from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { redirect } from 'react-router';

export type ProjectSummary = WorkspaceReadOutput<'projectsList'>['data'][number];
export type BoardSummary = WorkspaceReadOutput<'boardGet'>['data'];
export type ProjectList = WorkspaceReadOutput<'projectsList'>;

export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: unknown) {
    super('Planner could not complete this request.');
  }
}

export async function workspaceResponse(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new WorkspaceRequestError(response.status, body?.error?.code);
  }
  return response;
}

export async function readWorkspace<K extends WorkspaceReadOperation>(
  operation: K, id?: string, params = new URLSearchParams(), signal?: AbortSignal,
): Promise<WorkspaceReadOutput<K>> {
  const definition = workspaceOperations[operation];
  const path = id === undefined ? definition.path : definition.path.replace(':id', publicIdSchema.parse(id));
  const query = params.toString();
  const response = await workspaceResponse(path + (query ? '?' + query : ''), { signal });
  return definition.output.parse(await response.json()) as WorkspaceReadOutput<K>;
}

const preferencesPath = '/api/v1/me/preferences';
export type WorkspacePreferences = ReturnType<typeof accountPreferencesSchema.parse>;
export type DisplayPreferences = Pick<WorkspacePreferences['preferences'], 'homeView' | 'projectOrder' | 'showFavorites'>;

export async function readWorkspacePreferences(signal?: AbortSignal) {
  return accountPreferencesSchema.parse(await (await workspaceResponse(preferencesPath, { signal })).json());
}

export async function saveDisplayPreference<K extends keyof DisplayPreferences>(
  field: K, value: DisplayPreferences[K], revision: number, csrfToken: string,
) {
  const response = await workspaceResponse(preferencesPath, {
    method: 'PATCH', headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ revision, preferences: { [field]: value } }),
  });
  return accountPreferencesSchema.parse(await response.json());
}

export async function saveProjectFavorite(project: ProjectSummary, favorite: boolean, csrfToken: string) {
  const operation = relationshipCommands[favorite ? 'projects.favorite' : 'projects.unfavorite'];
  const response = await workspaceResponse(operation.path.replace(':id', publicIdSchema.parse(project.id)), {
    method: operation.method, headers: {
      'If-Match': '"' + project.revision + '"', 'Idempotency-Key': crypto.randomUUID(), 'X-CSRF-Token': csrfToken,
    },
  });
  if (response.status !== 204) operation.output.parse(await response.json());
}

export const requestDestination = (request: Request) => {
  const url = new URL(request.url);
  return url.pathname + url.search;
};

export function workspaceSignIn(request: Request) {
  return redirect(workspaceSignInPath(requestDestination(request)));
}
