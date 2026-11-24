import { createHash, randomUUID } from 'node:crypto';
import {
  generationIdSchema, maximumSignedInt64, minimumSignedInt64, publicIdSchema,
  signedInt64TextSchema, sourceAssetIdSchema, sourceEntitySchema, sourceUuidSchema,
} from '@planner/contracts/storage';
import { Long } from 'mongodb';

export { randomUUID as newPublicId };

export function legacyPublicId(sourceInstanceId: string, entity: string, sourceId: string) {
  const namespace = Buffer.from(sourceUuidSchema.parse(sourceInstanceId).replaceAll('-', ''), 'hex');
  const name = `${sourceEntitySchema.parse(entity)}:${sourceAssetIdSchema.parse(sourceId)}`;
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
