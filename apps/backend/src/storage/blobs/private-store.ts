import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';

export const digestPattern = /^[a-f0-9]{64}$/u;
const stagePattern = /^media-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;
export const mediaParts = ['original', 'small', 'large'] as const;
export type MediaPart = typeof mediaParts[number];
export type BlobIdentity = Readonly<{ digest: string; byteLength: number }>;
const { O_RDONLY, O_RDWR, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK, O_CREAT, O_EXCL } = constants;

export class MediaStorageError extends Error {
  constructor() { super('Private media storage is unavailable or inconsistent.'); }
}
export class MediaSizeError extends Error {
  constructor() { super('The uploaded file exceeds the media size limit.'); }
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const sameInode = (left: Stats, right: Stats) => left.ino === right.ino && left.dev === right.dev;

async function syncDirectory(path: string) {
  const descriptor = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

export async function inspectBlob(file: FileHandle, size: number): Promise<BlobIdentity> {
  const data = Buffer.allocUnsafe(128 * 1024);
  const hash = createHash('sha256');
  let byteLength = 0;
  while (byteLength < size) {
    const { bytesRead } = await file.read(data, 0, Math.min(data.length, size - byteLength), byteLength);
    if (!bytesRead) throw new MediaStorageError();
    hash.update(data.subarray(0, bytesRead));
    byteLength += bytesRead;
  }
  if ((await file.stat()).size !== size) throw new MediaStorageError();
  return { digest: hash.digest('hex'), byteLength };
}

export async function createPrivateMediaStore(staging: string, blobs: string) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || staging === blobs || dirname(staging) !== dirname(blobs)
      || ![staging, blobs].every((directory) => isAbsolute(directory) && normalize(directory) === directory)) throw new MediaStorageError();
  const root = dirname(staging);
  const parent = await lstat(root);
  if (!parent.isDirectory() || (parent.uid !== 0 && parent.uid !== uid) || (parent.mode & 0o022) !== 0
      || await realpath(root) !== root) throw new MediaStorageError();

  function ownedDirectory(info: Stats) {
    return info.isDirectory() && info.uid === uid && info.gid === gid && (info.mode & 0o7777) === 0o700;
  }
  const stagedRoot = await lstat(staging);
  const blobRoot = await lstat(blobs);
  if (!ownedDirectory(stagedRoot) || !ownedDirectory(blobRoot) || stagedRoot.dev !== blobRoot.dev
      || sameInode(stagedRoot, blobRoot)) throw new MediaStorageError();

  const activeStages = new Set<string>();
  const pinned = new Map<string, number>();
  const deleting = new Set<string>();
  let sweeper: Awaited<ReturnType<typeof opendir>> | undefined;
  let stageSweeper: Awaited<ReturnType<typeof opendir>> | undefined;

  async function checkRoot(path: string, expected: Stats) {
    const current = await lstat(path);
    if (!sameInode(parent, await lstat(root)) || !ownedDirectory(current) || !sameInode(current, expected)) {
      throw new MediaStorageError();
    }
  }

  function pathFor(digest: string) {
    if (!digestPattern.test(digest)) throw new MediaStorageError();
    return join(blobs, digest);
  }

  function ownedRegular(info: Stats, mode: number, maximumLinks = 2) {
    return info.isFile() && info.dev === blobRoot.dev && info.uid === uid && info.gid === gid
      && (info.mode & 0o7777) === mode && info.nlink > 0 && info.nlink <= maximumLinks;
  }

  async function openRegular(path: string) {
    const descriptor = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      if (!ownedRegular(await descriptor.stat(), 0o400)) throw new MediaStorageError();
      return descriptor;
    } catch (error) { await descriptor.close(); throw error; }
  }

  async function openBlob(identity: BlobIdentity) {
    await checkRoot(blobs, blobRoot);
    const descriptor = await openRegular(pathFor(identity.digest));
    try {
      if ((await descriptor.stat()).size !== identity.byteLength) throw new MediaStorageError();
      return descriptor;
    } catch (error) { await descriptor.close(); throw error; }
  }

  function pin(items: readonly BlobIdentity[]) {
    const digests = [...new Set(items.map(({ digest }) => digest))];
    if (digests.some((digest) => deleting.has(digest))) throw new MediaStorageError();
    for (const digest of digests) pinned.set(digest, (pinned.get(digest) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      for (const digest of digests) {
        const remaining = pinned.get(digest)! - 1;
        if (remaining === 0) pinned.delete(digest);
        else pinned.set(digest, remaining);
      }
    };
  }

  async function cleanStage(name: string, expected?: Stats) {
    if (!stagePattern.test(name)) throw new MediaStorageError();
    await checkRoot(staging, stagedRoot);
    const directory = join(staging, name);
    const info = await lstat(directory);
    if (!ownedDirectory(info) || info.dev !== stagedRoot.dev || (expected && !sameInode(info, expected))) {
      throw new MediaStorageError();
    }
    const reader = await opendir(directory);
    const parts: string[] = [];
    for await (const entry of reader) {
      if (!mediaParts.some((part) => part === entry.name)) throw new MediaStorageError();
      const item = await lstat(join(directory, entry.name));
      if (!ownedRegular(item, 0o600, 1) && !ownedRegular(item, 0o400)) throw new MediaStorageError();
      parts.push(entry.name);
    }
    for (const part of parts) await unlink(join(directory, part));
    await rmdir(directory);
    await syncDirectory(staging);
  }

  return {
    openBlob,
    pin,
    isPinned: (digest: string) => pinned.has(digest),
    async verifyBlob(identity: BlobIdentity) {
      const file = await openBlob(identity);
      try {
        if ((await inspectBlob(file, identity.byteLength)).digest !== identity.digest) throw new MediaStorageError();
      } finally { await file.close(); }
    },
    async stage() {
      await checkRoot(staging, stagedRoot);
      const name = 'media-' + randomUUID();
      const path = join(staging, name);
      activeStages.add(name);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { activeStages.delete(name); throw error; }
      const identity = await lstat(path);
      let openStage = true;
      const parts = new Set<MediaPart>();

      async function partPath(part: MediaPart) {
        const current = await lstat(path);
        if (!openStage || !mediaParts.includes(part) || !ownedDirectory(current) || !sameInode(current, identity)) {
          throw new MediaStorageError();
        }
        await checkRoot(staging, stagedRoot);
        return join(path, part);
      }

      async function createPart(part: MediaPart) {
        const file = await open(await partPath(part), O_RDWR | O_NOFOLLOW | O_CREAT | O_EXCL, 0o600);
        try {
          if (!ownedRegular(await file.stat(), 0o600, 1)) throw new MediaStorageError();
          return file;
        } catch (error) { await file.close(); throw error; }
      }

      async function seal(part: MediaPart, file: FileHandle, maximum: number) {
        const info = await file.stat();
        if (!ownedRegular(info, 0o600, 1) || !sameInode(info, await lstat(await partPath(part)))) throw new MediaStorageError();
        if (info.size > maximum) throw new MediaSizeError();
        await file.chmod(0o400);
        await file.sync();
        const result = await inspectBlob(file, info.size);
        parts.add(part);
        return result;
      }

      return {
        createPart,
        seal,
        async openPart(part: MediaPart) {
          if (!parts.has(part)) throw new MediaStorageError();
          return openRegular(await partPath(part));
        },
        async receive(input: Readable, maximum: number, signal: AbortSignal) {
          const file = await createPart('original');
          const sniff = Buffer.alloc(16);
          let size = 0;
          try {
            for await (const chunk of input) {
              signal.throwIfAborted();
              const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (size + data.length > maximum) throw new MediaSizeError();
              if (size < sniff.length) data.copy(sniff, size, 0, Math.min(data.length, sniff.length - size));
              await file.writeFile(data);
              size += data.length;
            }
            signal.throwIfAborted();
            const stored = await seal('original', file, maximum);
            if (stored.byteLength !== size) throw new MediaStorageError();
            return { identity: stored, prefix: sniff.subarray(0, Math.min(size, sniff.length)) };
          } finally { await file.close(); }
        },
        async publish(items: readonly { part: MediaPart; identity: BlobIdentity }[]) {
          const unpin = pin(items.map((item) => item.identity));
          try {
            await syncDirectory(path);
            await checkRoot(blobs, blobRoot);
            for (const { part, identity: blob } of items) {
              if (!parts.has(part)) throw new MediaStorageError();
              const from = await partPath(part);
              const source = await openRegular(from);
              try {
                const before = await source.stat();
                if (before.size !== blob.byteLength || (await inspectBlob(source, before.size)).digest !== blob.digest
                    || !sameInode(before, await lstat(from))) throw new MediaStorageError();
                try { await link(from, pathFor(blob.digest)); }
                catch (error) {
                  if (errorCode(error) !== 'EEXIST') throw error;
                  const existing = await openBlob(blob);
                  try {
                    if ((await inspectBlob(existing, blob.byteLength)).digest !== blob.digest) throw new MediaStorageError();
                    await existing.sync();
                  } finally { await existing.close(); }
                }
              } finally { await source.close(); }
            }
            await syncDirectory(blobs);
            return unpin;
          } catch (error) { unpin(); throw error; }
        },
        async dispose() {
          if (!openStage) return;
          openStage = false;
          try { await cleanStage(name, identity); } finally { activeStages.delete(name); }
        },
      };
    },
    async candidates(maximum: number, earlierThan: number) {
      await checkRoot(blobs, blobRoot);
      sweeper ??= await opendir(blobs);
      const ids: string[] = [];
      for (let count = 0; count < maximum; count += 1) {
        const entry = await sweeper.read();
        if (!entry) {
          await sweeper.close();
          sweeper = undefined;
          break;
        }
        if (!entry.isFile() || !digestPattern.test(entry.name) || pinned.has(entry.name)) continue;
        const info = await lstat(pathFor(entry.name)).catch((error: unknown) => {
          if (errorCode(error) === 'ENOENT') return null;
          throw error;
        });
        if (info && ownedRegular(info, 0o400, 1) && info.mtimeMs <= earlierThan) ids.push(entry.name);
      }
      return ids;
    },
    async deleteOrphan(digest: string) {
      await checkRoot(blobs, blobRoot);
      if (pinned.has(digest)) return false;
      const name = pathFor(digest);
      const info = await lstat(name);
      if (!ownedRegular(info, 0o400, 1)) return false;
      if (pinned.has(digest) || deleting.has(digest)) return false;
      deleting.add(digest);
      try {
        await unlink(name);
        await syncDirectory(blobs);
        return true;
      } finally { deleting.delete(digest); }
    },
    async sweepStages(maximum: number, earlierThan: number) {
      await checkRoot(staging, stagedRoot);
      stageSweeper ??= await opendir(staging);
      for (let count = 0; count < maximum; count += 1) {
        const entry = await stageSweeper.read();
        if (!entry) {
          await stageSweeper.close();
          stageSweeper = undefined;
          break;
        }
        if (!entry.isDirectory() || !stagePattern.test(entry.name) || activeStages.has(entry.name)) continue;
        const candidate = await lstat(join(staging, entry.name));
        if (ownedDirectory(candidate) && candidate.mtimeMs <= earlierThan) await cleanStage(entry.name, candidate);
      }
    },
    async close() {
      await Promise.all([sweeper?.close(), stageSweeper?.close()]);
    },
  };
}

export type PrivateMediaStore = Awaited<ReturnType<typeof createPrivateMediaStore>>;
export type PrivateMediaStage = Awaited<ReturnType<PrivateMediaStore['stage']>>;
