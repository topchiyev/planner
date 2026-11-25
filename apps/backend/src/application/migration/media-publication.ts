import { Readable } from 'node:stream';
import type { BlobIdentity, MediaPart, PrivateMediaStage, PrivateMediaStore } from '../../storage/blobs/private-store.js';
import { detectImage, imageTypes, type MediaDecoder, type MediaVariants } from '../media/decoder.js';
import { originalType } from '../media/records.js';
import { MigrationError } from './manifest.js';

export type MediaInput = (consume: (bytes: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<void>, signal: AbortSignal) => Promise<void>;
export type PreparedMigrationMedia = BlobIdentity & { mimeType: string; variants: MediaVariants | null };
export type MigrationMediaPublisher = (expected: BlobIdentity, read: MediaInput, signal: AbortSignal) => Promise<{
  media: PreparedMigrationMedia; publish: () => Promise<void>; close: () => Promise<void>;
}>;

export async function receiveMigrationMedia(stage: PrivateMediaStage, expected: BlobIdentity, bytes: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const received = await stage.receive(Readable.from(bytes), expected.byteLength, signal);
  if (received.identity.digest !== expected.digest || received.identity.byteLength !== expected.byteLength) {
    throw new MigrationError('asset-integrity', 'Staged media does not match the verified source bytes.');
  }
  return received;
}

export async function prepareMigrationMedia(stage: PrivateMediaStage, received: Awaited<ReturnType<typeof receiveMigrationMedia>>,
  decode: MediaDecoder, signal: AbortSignal) {
  const { identity, prefix } = received;
  const format = detectImage(prefix);
  const variants = format ? await decode(stage, format, signal) : null;
  const parts: { part: MediaPart; identity: BlobIdentity }[] = [{ part: 'original', identity }];
  if (variants) parts.push({ part: 'small', identity: variants.small }, { part: 'large', identity: variants.large });
  return { parts, media: { ...identity, mimeType: format ? imageTypes[format] : originalType, variants } };
}

export function localMigrationMediaPublisher(store: PrivateMediaStore, decode: MediaDecoder): MigrationMediaPublisher {
  return async (expected, read, signal) => {
    const stage = await store.stage();
    let unpin: (() => void) | undefined;
    const close = async () => { try { await stage.dispose(); } finally { unpin?.(); } };
    try {
      let received: Awaited<ReturnType<typeof receiveMigrationMedia>> | undefined;
      await read(async (bytes, reading) => { received = await receiveMigrationMedia(stage, expected, bytes, reading); }, signal);
      if (!received) throw new MigrationError('asset-integrity', 'The verified source media was not read.');
      const { media, parts } = await prepareMigrationMedia(stage, received, decode, signal);
      return { media, async publish() { unpin = await stage.publish(parts); }, close };
    } catch (error) { await close(); throw error; }
  };
}
