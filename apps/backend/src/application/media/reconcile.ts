import type { Db } from 'mongodb';
import type { CommandGate } from '../command-gate/gate.js';
import { checkCommand, commands, durable, readBatches } from '../command-journal/records.js';
import { readInstallation, requireCurrentSchema } from '../../storage/schema.js';
import { digestPattern, MediaStorageError, type BlobIdentity, type PrivateMediaStore } from '../../storage/blobs/private-store.js';
import { availableMedia, catalogVariants, mediaRecords, validBlobIdentity, type MediaCatalog, type StoredAvatar, type StoredMediaReference } from './records.js';

export const mediaOrphanGraceMs = 24 * 60 * 60 * 1000;
const referenceCollections = ['attachments', 'projectBackgrounds'] as const;

export async function verifyActiveMedia(database: Db, installationId: string, store: PrivateMediaStore) {
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  const generationId = installation.activeGenerationId;
  if (!generationId) return;
  const records = mediaRecords(database, generationId);
  const checked = new Map<string, number>();
  async function check(identity: BlobIdentity) {
    if (!validBlobIdentity(identity)) throw new MediaStorageError();
    if (checked.has(identity.digest)) {
      if (checked.get(identity.digest) !== identity.byteLength) throw new MediaStorageError();
      return;
    }
    await store.verifyBlob(identity);
    checked.set(identity.digest, identity.byteLength);
  }
  async function verifyReference(digest: string | null | undefined, bytes: number | null | undefined) {
    const identity = { digest, byteLength: bytes };
    if (!validBlobIdentity(identity)) throw new MediaStorageError();
    const row = await records.catalog(identity.digest);
    if (!row || row.lifecycleState !== availableMedia || row.byteLength !== identity.byteLength) throw new MediaStorageError();
    await check(identity);
    const variants = catalogVariants(row);
    if (variants) {
      await check(variants.small);
      await check(variants.large);
    }
  }
  for (const name of referenceCollections) {
    const cursor = database.collection<StoredMediaReference>(name).find({
      generationId, kind: 'file', availability: availableMedia, deletedAt: null,
    }, { projection: { blobDigest: 1, byteLength: 1 } });
    for await (const row of cursor) await verifyReference(row.blobDigest, row.byteLength);
  }
  const avatars = database.collection<StoredAvatar>('users').find({
    generationId, 'avatarMedia.availability': availableMedia,
  }, { projection: { avatarBlobDigest: 1, 'avatarMedia.byteLength': 1 } });
  for await (const row of avatars) await verifyReference(row.avatarBlobDigest, row.avatarMedia?.byteLength);
}

// All-generation scans are intentionally confined to maintenance under the exclusive writer.
async function preparedDigests(database: Db) {
  const digests = new Set<string>();
  const pending = commands(database).find({ status: 'prepared' }, { promoteLongs: false, batchSize: 8 });
  let count = 0;
  let effects = 0;
  const remember = (digest: unknown) => {
    if (digest === null || digest === undefined) return;
    if (typeof digest !== 'string' || !digestPattern.test(digest)) throw new MediaStorageError();
    digests.add(digest);
  };
  for await (const command of pending) {
    if (++count > 128) return null;
    checkCommand(command);
    for await (const batch of readBatches(database, command)) {
      effects += batch.length;
      if (effects > 8192) return null;
      for (const effect of batch) {
        if (effect.kind === 'delete') continue;
        if (effect.collection === 'attachments' || effect.collection === 'projectBackgrounds') remember(effect.fields.blobDigest);
        if (effect.collection === 'users') remember(effect.fields.avatarBlobDigest);
        if (effect.collection !== 'blobs') continue;
        remember(effect.fields.digest);
        const variants = effect.fields.variants;
        if (variants == null) continue;
        if (typeof variants !== 'object' || Array.isArray(variants)
            || !validBlobIdentity(variants.small) || !validBlobIdentity(variants.large)) throw new MediaStorageError();
        remember(variants.small.digest);
        remember(variants.large.digest);
      }
    }
  }
  return digests;
}

async function liveReferences(database: Db, digest: string) {
  for (const name of referenceCollections) {
    if (await database.collection(name).findOne({ blobDigest: digest }, { projection: { _id: 1 } })) return true;
  }
  return !!await database.collection('users').findOne({ avatarBlobDigest: digest }, { projection: { _id: 1 } });
}

export async function sweepPrivateMedia(
  database: Db, store: PrivateMediaStore, now = new Date(), maximum = 32,
) {
  const cutoff = now.getTime() - mediaOrphanGraceMs;
  if (!Number.isFinite(cutoff) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128) throw new MediaStorageError();
  await store.sweepStages(maximum, cutoff);
  const candidates = await store.candidates(maximum, cutoff);
  if (!candidates.length) return;
  const protectedDigests = await preparedDigests(database);
  if (!protectedDigests) return;
  const catalogs = database.collection<MediaCatalog>('blobs');
  async function protectedBlob(digest: string) {
    if (protectedDigests!.has(digest) || await liveReferences(database, digest)) return true;
    const parents = catalogs.find({ $or: [{ 'variants.small.digest': digest }, { 'variants.large.digest': digest }] },
      { projection: { digest: 1, variants: 1 }, limit: 129 });
    let count = 0;
    for await (const parent of parents) {
      if (++count > 128 || !digestPattern.test(parent.digest)) return true;
      if (protectedDigests!.has(parent.digest) || await liveReferences(database, parent.digest)) return true;
    }
    return false;
  }
  for (const digest of candidates) {
    if (store.isPinned(digest) || await protectedBlob(digest)) continue;
    if (await store.deleteOrphan(digest)) await catalogs.deleteMany({ digest }, durable);
  }
}

export function startMediaCleanup(gate: CommandGate, cleanup: () => Promise<void>) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  async function run() {
    try { if (!stopped && gate.ready) await cleanup(); }
    catch {
      if (!stopped && !gate.ready) console.error('Planner private media cleanup could not be completed.');
    } finally { if (!stopped) schedule(); }
  }
  function schedule() {
    timer = setTimeout(() => { void run(); }, 60_000);
    timer.unref();
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
