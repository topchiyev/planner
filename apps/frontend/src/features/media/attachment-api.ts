import { maximumMediaBytes, mediaMutationSchema, mediaOperations, relationshipParentRevisionHeader, type MediaVariant } from '@planner/contracts';
import { publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { workspaceResponse, WorkspaceRequestError } from '../workspace/workspace-api.js';

type Write = 'uploadAttachment' | 'addLink' | 'renameAttachment' | 'removeAttachment';

function withId(path: string, id: string) {
  return path.replace(':id', publicIdSchema.parse(id));
}

export function attachmentDownload(id: string) {
  return withId(mediaOperations.attachmentDownload.path, id);
}

export function attachmentThumbnail(id: string, variant: MediaVariant = 'small') {
  return withId(mediaOperations.attachmentThumbnail.path, id).replace(':variant', variant);
}

export function attachmentFileForm(file: File) {
  if (file.size > maximumMediaBytes) throw new WorkspaceRequestError(413, 'MEDIA_SIZE');
  const body = new FormData();
  body.set('byteLength', String(file.size));
  body.set('file', file);
  return body;
}

export async function attachmentWrite(operation: Write, id: string, revision: number, csrf: string, key: string, input?: FormData | object) {
  const { method, path } = mediaOperations[operation];
  const json = input && !(input instanceof FormData);
  const response = await workspaceResponse(withId(path, id), {
    method,
    headers: {
      'X-CSRF-Token': csrf, 'Idempotency-Key': key, 'If-Match': `"${revision}"`,
      ...(json && { 'Content-Type': 'application/json' }),
    },
    body: json ? JSON.stringify(input) : input as FormData | undefined,
  });
  if (response.status === 204) {
    const revision = response.headers.get(relationshipParentRevisionHeader);
    return { parentRevision: revisionSchema.parse(revision === null ? undefined : Number(revision)) };
  }
  return mediaMutationSchema.parse(await response.json()).data;
}
