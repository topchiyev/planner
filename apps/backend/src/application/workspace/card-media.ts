import { publicIdSchema } from '@planner/contracts/storage';
import { MediaStorageError } from '../../storage/blobs/private-store.js';
import { availableMedia, catalogVariants, unavailableMedia, validBlobIdentity, type MediaCatalog } from '../media/records.js';
import { canonicalRow, equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Attachment = WorkspaceRow<'attachments'>;
type Card = Pick<WorkspaceRow<'cards'>, 'id' | 'coverAttachmentId'>;

export function cardAttachmentRows(records: WorkspaceRecords, generationId: string, cardId: string) {
  return records.find('attachments', { cardId, deletedAt: null, kind: { $in: ['file', 'link'] },
    $expr: { $and: [canonicalRow(generationId), equal('cardId', cardId), { $in: ['$kind', ['file', 'link']] }] },
  }, { createdAt: 1, id: 1 });
}

export async function attachmentFiles(records: WorkspaceRecords, generationId: string, rows: readonly Attachment[]) {
  const identities = new Map(rows.flatMap((row) => {
    const identity = { digest: row.blobDigest, byteLength: row.byteLength };
    return row.kind === 'file' && row.deletedAt == null && row.availability === availableMedia && validBlobIdentity(identity)
      ? [[row.id, identity] as const] : [];
  }));
  const digests = [...new Set([...identities.values()].map(({ digest }) => digest))];
  const blobs = digests.length ? await records.aggregate<MediaCatalog>('blobs', {
    digest: { $in: digests }, lifecycleState: availableMedia,
    $expr: { $and: [canonicalRow(generationId), equal('lifecycleState', availableMedia), { $in: ['$digest', digests] }] },
  }, []) : [];
  const catalog = new Map(blobs.map((row) => [row.digest, row]));
  return new Map([...identities].flatMap(([id, identity]) => {
    const blob = catalog.get(identity.digest);
    if (!blob || !validBlobIdentity(blob) || blob.byteLength !== identity.byteLength) return [];
    let hasThumbnail = false;
    try {
      hasThumbnail = catalogVariants(blob) !== null;
    } catch (error) {
      if (!(error instanceof MediaStorageError)) throw error;
    }
    return [[id, { byteLength: identity.byteLength, hasThumbnail }]] as const;
  }));
}

export async function selectableCardCover(records: WorkspaceRecords, generationId: string, cardId: string, attachmentId: string) {
  const attachment = await records.get('attachments', attachmentId);
  if (!attachment || attachment.cardId !== cardId || attachment.kind !== 'file' || attachment.deletedAt != null) return false;
  return (await attachmentFiles(records, generationId, [attachment])).get(attachmentId)?.hasThumbnail === true;
}

type AttachmentFiles = Awaited<ReturnType<typeof attachmentFiles>>;

export function coverForCard(card: Card, attachment: Attachment | undefined, files: AttachmentFiles) {
  if (!attachment || card.coverAttachmentId !== attachment.id || attachment.cardId !== card.id
      || attachment.kind !== 'file' || attachment.deletedAt != null) return null;
  if (attachment.availability === unavailableMedia) return { attachmentId: attachment.id, hasThumbnail: false };
  return files.get(attachment.id)?.hasThumbnail ? { attachmentId: attachment.id, hasThumbnail: true } : null;
}

export async function cardCovers(records: WorkspaceRecords, generationId: string, cards: readonly Card[]) {
  const ids = [...new Set(cards.flatMap(({ coverAttachmentId }) =>
    publicIdSchema.safeParse(coverAttachmentId).success ? [coverAttachmentId!] : []))];
  if (!ids.length) return new Map<string, NonNullable<ReturnType<typeof coverForCard>>>();
  const cardIds = cards.map(({ id }) => id);
  const rows = await records.find('attachments', { id: { $in: ids }, cardId: { $in: cardIds }, deletedAt: null, kind: 'file',
    $expr: { $and: [canonicalRow(generationId), equal('kind', 'file'), { $in: ['$id', ids] }, { $in: ['$cardId', cardIds] }] },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const files = await attachmentFiles(records, generationId, rows);
  return new Map(cards.flatMap((card) => {
    const cover = card.coverAttachmentId && coverForCard(card, byId.get(card.coverAttachmentId), files);
    return cover ? [[card.id, cover]] as const : [];
  }));
}
