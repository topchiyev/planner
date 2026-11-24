import { maximumMediaBytes, mediaMutationSchema, mediaOperations, relationshipCommands, relationshipReads,
  type RelationshipCommandOutput, type RelationshipReadOutput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { workspaceResponse, WorkspaceRequestError } from '../workspace/workspace-api.js';

type ProjectCommand = 'projects.create' | 'projects.update' | 'projects.delete' | 'projects.addManager' | 'projects.removeManager';
type ProjectRead = 'projects.managers' | 'projects.managerCandidates';

function pathWithId(path: string, marker: string, id: string | undefined) {
  return id === undefined ? path : path.replace(marker, publicIdSchema.parse(id));
}

function headers(csrf: string, key: string, revision?: number | null): Record<string, string> {
  return { 'X-CSRF-Token': csrf, 'Idempotency-Key': key,
    ...(revision !== undefined && { 'If-Match': `"${revision ?? 0}"` }) };
}

export async function projectCommand<K extends ProjectCommand>(command: K, csrf: string, key: string, options: {
  id?: string; userId?: string; revision?: number | null; body?: object;
} = {}): Promise<RelationshipCommandOutput<K> | undefined> {
  const operation = relationshipCommands[command];
  const path = pathWithId(pathWithId(operation.path, ':id', options.id), ':userId', options.userId);
  const response = await workspaceResponse(path, {
    method: operation.method, headers: { ...headers(csrf, key, options.revision), ...(options.body && { 'Content-Type': 'application/json' }) },
    body: options.body && JSON.stringify(options.body),
  });
  return response.status === 204 ? undefined : operation.output.parse(await response.json()) as RelationshipCommandOutput<K>;
}

export async function readProjectAffiliation<K extends ProjectRead>(command: K, id: string, query: URLSearchParams, signal: AbortSignal) {
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
