import { CleanCommandRejection } from '../command-gate/gate.js';

export const mediaErrors = {
  input: [422, 'INVALID_REQUEST', 'Check the media upload and its preconditions.'],
  type: [415, 'UNSUPPORTED_MEDIA', 'Use a supported image format for this media.'],
  image: [422, 'INVALID_IMAGE', 'The image could not be decoded within the supported limits.'],
  limit: [413, 'MEDIA_TOO_LARGE', 'The uploaded file exceeds 32 MiB or its envelope limit.'],
  timeout: [408, 'UPLOAD_TIMEOUT', 'The time allowed to upload the file elapsed.'],
  busy: [429, 'MEDIA_BUSY', 'Too many media operations are active. Try again shortly.'],
  catalog: [503, 'UNAVAILABLE', 'Planner is unavailable.'],
  revision: [409, 'REVISION_CONFLICT', 'The media or its parent changed. Reload and try again.'],
} as const;

export class MediaRejection extends CleanCommandRejection {
  constructor(readonly kind: keyof typeof mediaErrors) { super(mediaErrors[kind][2]); }
}

export function reserveSlots(limit: number) {
  let active = 0;
  return () => {
    if (active >= limit) throw new MediaRejection('busy');
    active += 1;
    return () => { active -= 1; };
  };
}
