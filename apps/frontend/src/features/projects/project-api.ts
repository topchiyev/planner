import { maximumMediaBytes, mediaMutationSchema, mediaOperations, relationshipCommands, relationshipReads,
  type RelationshipCommand, type RelationshipCommandOutput, type RelationshipRead, type RelationshipReadOutput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { workspaceResponse, WorkspaceRequestError } from '../workspace/workspace-api.js';

export { relationshipCommand as projectCommand, readAffiliation as readProjectAffiliation };

function pathWithId(path: string, marker: string, id: string | undefined) {
  return id === undefined ? path : path.replace(marker, publicIdSchema.parse(id));
}

function headers(csrf: string, key: string, revision?: number | null): Record<string, string> {
  return { 'X-CSRF-Token': csrf, 'Idempotency-Key': key,
    ...(revision !== undefined && { 'If-Match': `"${revision ?? 0}"` }) };
}

export async function relationshipCommand<K extends RelationshipCommand>(command: K, csrf: string, key: string, options: {
  id?: string; userId?: string; relatedId?: string; revision?: number | null; body?: object;
} = {}): Promise<RelationshipCommandOutput<K> | undefined> {
  const operation = relationshipCommands[command];
  const parent = pathWithId(operation.path, ':id', options.id);
  const path = pathWithId(pathWithId(parent, ':userId', options.userId), ':relatedId', options.relatedId);
  const response = await workspaceResponse(path, {
    method: operation.method, headers: { ...headers(csrf, key, options.revision), ...(options.body && { 'Content-Type': 'application/json' }) },
    body: options.body && JSON.stringify(options.body),
  });
  return response.status === 204 ? undefined : operation.output.parse(await response.json()) as RelationshipCommandOutput<K>;
}

export async function readAffiliation<K extends RelationshipRead>(command: K, id: string, query: URLSearchParams, signal: AbortSignal) {
  const operation = relationshipReads[command];
  const response = await workspaceResponse(pathWithId(operation.path, ':id', id) + '?' + query, { signal });
  return operation.output.parse(await response.json()) as RelationshipReadOutput<K>;
}

export function projectBackgroundImage(id: string, backgroundId: string, variant: 'small' | 'large' = 'small') {
  return pathWithId(pathWithId(mediaOperations.backgroundThumbnail.path, ':id', id), ':backgroundId', backgroundId).replace(':variant', variant);
}

export async function uploadProjectBackground(id: string, revision: number, file: File, csrf: string, key: string) {
  if (file.size > maximumMediaBytes) throw new WorkspaceRequestError(413, 'MEDIA_SIZE');
  const form = new FormData();
  form.set('byteLength', String(file.size));
  form.set('file', file);
  const operation = mediaOperations.uploadBackground;
  const response = await workspaceResponse(pathWithId(operation.path, ':id', id), {
    method: operation.method, headers: headers(csrf, key, revision), body: form,
  });
  return mediaMutationSchema.parse(await response.json());
}

export async function removeProjectBackground(id: string, backgroundId: string, revision: number, csrf: string, key: string) {
  const operation = mediaOperations.removeBackground;
  await workspaceResponse(pathWithId(pathWithId(operation.path, ':id', id), ':backgroundId', backgroundId), {
    method: operation.method, headers: headers(csrf, key, revision),
  });
}
