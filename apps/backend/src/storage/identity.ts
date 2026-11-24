import { createHash, randomUUID } from 'node:crypto';
import {
  generationIdSchema, maximumSignedInt64, minimumSignedInt64, parseSourceIdentity, publicIdSchema,
  signedInt64TextSchema, sourceUuidSchema,
} from '@planner/contracts/storage';
import { Long } from 'mongodb';

export { randomUUID as newPublicId };
export const signedLongFields = ['rank', 'historySequence', 'recoverySequence', 'sequence'] as const;
export const storedInstantFields = [
  'createdAt', 'updatedAt', 'listChangedAt', 'issuedAt', 'expiresAt', 'consumedAt', 'revokedAt', 'readAt',
] as const;

export function legacyPublicId(sourceInstanceId: string, entity: string, sourceId: string) {
  const namespace = Buffer.from(sourceUuidSchema.parse(sourceInstanceId).replaceAll('-', ''), 'hex');
  const identity = parseSourceIdentity(entity, sourceId);
  const name = `${identity.entity}:${identity.sourceId}`;
  const bytes = createHash('sha1').update(namespace).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function workspaceKey(generationId: string, publicId: string) {
  return `${generationIdSchema.parse(generationId)}/${publicIdSchema.parse(publicId)}`;
}

export function encodeRank(value: bigint | string) {
  const exact = typeof value === 'string' ? BigInt(signedInt64TextSchema.parse(value)) : value;
  if (typeof exact !== 'bigint' || exact < minimumSignedInt64 || exact > maximumSignedInt64) {
    throw new RangeError('Rank is outside the signed 64-bit range.');
  }
  return Long.fromBigInt(exact);
}

export function decodeRank(value: Long) {
  if (!Long.isLong(value) || value.unsigned) throw new TypeError('Expected a signed BSON Long rank.');
  return value.toBigInt();
}

export function readLongField(field: string, value: unknown) {
  if (field === 'rank' && value === null) return null;
  if (!Long.isLong(value)) throw new TypeError('Expected a signed BSON Long rank or sequence.');
  return decodeRank(value);
}

export function isStoredDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function readStoredInstant(value: unknown) {
  if (value === null || isStoredDate(value)) return value;
  throw new TypeError('Expected a BSON Date or explicit null.');
}

function compareId(first: string, second: string) {
  return first === second ? 0 : first < second ? -1 : 1;
}

export function comparePlacement(
  first: { id: string; rank: Long }, second: { id: string; rank: Long },
) {
  return first.rank.compare(second.rank) || compareId(first.id, second.id);
}

export function compareHistory(
  first: { id: string; listChangedAt: Date; historySequence: Long },
  second: { id: string; listChangedAt: Date; historySequence: Long },
) {
  return second.listChangedAt.valueOf() - first.listChangedAt.valueOf()
    || second.historySequence.compare(first.historySequence) || compareId(second.id, first.id);
}
