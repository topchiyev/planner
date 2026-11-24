import type { WorkspaceReadOutput } from '@planner/contracts';
import { attachmentThumbnail } from './attachment-api.js';
import './card-media.css';

type Cover = WorkspaceReadOutput<'boardCards'>['data'][number]['cover'];

export function CardFrontCover({ cover }: { cover: Cover }) {
  if (!cover) return null;
  return cover.hasThumbnail
    ? <img className="card-front-cover" src={attachmentThumbnail(cover.attachmentId)} alt="" loading="lazy" decoding="async" />
    : <span className="card-cover-unavailable">Cover unavailable</span>;
}
