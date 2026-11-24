import { projectGradientSchema, type ProjectBackground } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { availableMedia, catalogVariants, mediaRecords, validBlobIdentity } from '../media/records.js';
import type { WorkspaceRow } from './records.js';

export async function availableProjectImage(db: Db, generationId: string, projectId: string, id: string) {
  if (!publicIdSchema.safeParse(id).success) return null;
  const records = mediaRecords(db, generationId);
  const ref = await records.background(id);
  if (!ref || ref.projectId !== projectId || ref.kind !== 'file' || ref.availability !== availableMedia || ref.deletedAt != null) return null;
  if (!validBlobIdentity({ digest: ref.blobDigest, byteLength: ref.byteLength })) return null;
  const blob = await records.catalog(ref.blobDigest!);
  return blob?.lifecycleState === availableMedia && blob.byteLength === ref.byteLength && catalogVariants(blob) ? ref : null;
}

export async function effectiveProjectBackground(db: Db, generationId: string, project: WorkspaceRow<'projects'>): Promise<ProjectBackground> {
  if (project.backgroundId) {
    const image = await availableProjectImage(db, generationId, project.id, project.backgroundId);
    if (image) return { kind: 'image', id: image.id };
  }
  const preset = projectGradientSchema.safeParse(project.backgroundPreset);
  return preset.success ? { kind: 'preset', preset: preset.data } : null;
}
