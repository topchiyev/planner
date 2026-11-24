import { redirect } from 'react-router';

export class AccountRequestError extends Error {
  constructor(readonly status: number, readonly code: unknown, message: string) { super(message); }
}

export async function accountRequest<T>(path: string, schema: { parse(input: unknown): T }, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store' });
  if (response.status === 401) throw redirect('/sign-in');
  if (response.status === 204) return schema.parse(undefined);
  const data = await response.json();
  if (!response.ok) {
    throw new AccountRequestError(response.status, data?.error?.code,
      typeof data?.error?.message === 'string' ? data.error.message : 'Planner could not complete this request.');
  }
  return schema.parse(data);
}

export function accountMutation(method: string, csrfToken: string, body: unknown, key?: string): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...(key && { 'Idempotency-Key': key }) },
    body: JSON.stringify(body),
  };
}

export function accountError(error: unknown) {
  if (error instanceof Response && error.status === 302) window.location.replace('/sign-in');
  return error instanceof Error ? error.message : 'Planner could not complete this request.';
}
