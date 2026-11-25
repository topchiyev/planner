import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationAsset, MigrationCapture } from '@planner/contracts';
import { anchoredDirectory, fdPath, fileChunks, type Owner } from '../backup/archive.js';
import { assetKeyKind, keyComponents, MigrationError, registerPath } from './manifest.js';
import type { SourceAsset } from './source-reader.js';
import { migrationServiceName } from './source-service.js';

const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = constants;
const pathDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type ObjectService = { base: URL; token?: string; snapshotId: string };
type Contents = { length: number; digest: string };
type Reader = { inspect: (asset: MigrationAsset) => Promise<Contents | null>; close: () => Promise<void> };

function invalid() {
  return new MigrationError('asset-integrity', 'An asset is unsafe, corrupt or inconsistent with the selected snapshot.');
}

function unknownService() {
  return new MigrationError('asset-manifest', 'Select a protected immutable object snapshot service.');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseObjectService(config: string, name: string, capture: MigrationCapture): ObjectService {
  try {
    if (!migrationServiceName.test(name) || Buffer.byteLength(config) > 64 * 1024) throw unknownService();
    const services: unknown = JSON.parse(config);
    if (!record(services) || !Object.hasOwn(services, name)) throw unknownService();
    const section = services[name];
    if (!record(section) || Object.keys(section).some((key) => !['base', 'token', 'snapshotId'].includes(key))
      || typeof section.base !== 'string' || section.snapshotId !== capture.asset.snapshotId
      || capture.asset.kind !== 'object' || (section.token !== undefined
        && (typeof section.token !== 'string' || !/^[A-Za-z0-9_.~+/=-]{1,2048}$/u.test(section.token)))) throw unknownService();
    const base = new URL(section.base);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || base.href !== section.base || !base.pathname.endsWith('/') || /%(?:2f|5c)/iu.test(base.pathname)) throw unknownService();
    return { base, token: section.token, snapshotId: capture.asset.snapshotId };
  } catch { throw unknownService(); }
}

async function hash(chunks: AsyncIterable<Uint8Array>, maximum: number) {
  const digest = createHash('sha256');
  let length = 0;
  for await (const chunk of chunks) {
    length += chunk.byteLength;
    if (length > maximum) throw invalid();
    digest.update(chunk);
  }
  return { length, digest: digest.digest('hex') };
}

export async function inspectDirectory(root: string, owner: Owner, manifest: ReadonlyMap<string, MigrationAsset>): Promise<Reader> {
  const directory = await anchoredDirectory(root, owner, 0o700);
  const known = new Map<string, string>();
  const declaredDirectories = new Set<string>();
  for (const key of manifest.keys()) registerPath(known, key);
  for (const key of known.values()) {
    if (!manifest.has(key)) declaredDirectories.add(key);
  }
  const contents = new Map<string, Contents>();
  let total = 0;

  async function walk(parent: FileHandle, prefix: string) {
    // Node's directory iterator supports raw names even though its declarations omit this encoding.
    const entries = await opendir(fdPath(parent), { encoding: 'buffer' as BufferEncoding });
    const observed = new Set<string>();
    for await (const entry of entries) {
      total += 1;
      if (total > 200_000 || !Buffer.isBuffer(entry.name)) throw invalid();
      const leaf = pathDecoder.decode(entry.name);
      if (!Buffer.from(leaf, 'utf8').equals(entry.name) || observed.has(leaf)) throw invalid();
      observed.add(leaf);
      const key = prefix + leaf;
      registerPath(known, key);
      const path = join(fdPath(parent), leaf);
      if (entry.isDirectory()) {
        if (!declaredDirectories.has(key)) throw invalid();
        const child = await open(path, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
        try {
          const info = await child.stat();
          if (!info.isDirectory() || info.uid !== owner.uid || info.gid !== owner.gid || (info.mode & 0o077) !== 0) throw invalid();
          await walk(child, key + '/');
        } finally { await child.close(); }
        continue;
      }
      const expected = manifest.get(key);
      if (!entry.isFile() || !expected) throw invalid();
      const file = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try {
        const atStart = await file.stat();
        if (!atStart.isFile() || atStart.uid !== owner.uid || atStart.gid !== owner.gid || (atStart.mode & 0o077) !== 0
            || atStart.nlink !== 1 || atStart.size !== expected.size) throw invalid();
        const observed = await hash(fileChunks(file, expected.size), expected.size);
        const atEnd = await file.stat();
        if (atEnd.mtimeMs !== atStart.mtimeMs || atEnd.ctimeMs !== atStart.ctimeMs) throw invalid();
        contents.set(key, observed);
      } finally { await file.close(); }
    }
  }

  try {
    await walk(directory, '');
    return { inspect: async (asset) => contents.get(asset.key) ?? null, close: () => directory.close() };
  } catch (error) {
    await directory.close();
    if (error instanceof MigrationError) throw error;
    throw invalid();
  }
}

type ConsumeAsset<T> = (bytes: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<T>;

export async function withDirectoryAsset<T>(
  root: string, owner: Owner, asset: MigrationAsset, use: ConsumeAsset<T>, signal: AbortSignal,
) {
  const handles: FileHandle[] = [];
  let file: FileHandle;
  try {
    try {
      handles.push(await anchoredDirectory(root, owner, 0o700));
      const components = keyComponents(asset.key);
      const leaf = components.pop()!;
      for (const component of components) {
        const child = await open(join(fdPath(handles.at(-1)!), component), O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
        handles.push(child);
        const info = await child.stat();
        if (!info.isDirectory() || info.uid !== owner.uid || info.gid !== owner.gid || (info.mode & 0o077) !== 0) throw invalid();
      }
      file = await open(join(fdPath(handles.at(-1)!), leaf), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      handles.push(file);
    } catch { throw invalid(); }
    const before = await file.stat();
    if (!before.isFile() || before.uid !== owner.uid || before.gid !== owner.gid || (before.mode & 0o077) !== 0
      || before.nlink !== 1 || before.size !== asset.size) throw invalid();
    const result = await use(fileChunks(file, asset.size), signal);
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid();
    return result;
  } finally { await Promise.allSettled(handles.reverse().map((handle) => handle.close())); }
}

export async function withObjectAsset<T>(
  service: ObjectService, asset: MigrationAsset, use: ConsumeAsset<T>, request = fetch, signal?: AbortSignal,
): Promise<T | null> {
  if (!asset.versionId || asset.versionId === 'null') throw invalid();
  const item = new URL(keyComponents(asset.key).map(encodeURIComponent).join('/'), service.base);
  item.searchParams.set('versionId', asset.versionId);
  const deadline = AbortSignal.timeout(35_000);
  const connection = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await request(item, {
      redirect: 'error', signal: connection,
      headers: { 'Accept-Encoding': 'identity', ...(service.token && { Authorization: 'Bearer ' + service.token }) },
    });
  } catch { throw invalid(); }
  try {
    if (response.status === 404) return null;
    const contentLength = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (response.status !== 200 || !response.body || response.headers.get('x-amz-version-id') !== asset.versionId
      || (encoding && encoding !== 'identity') || (contentLength !== null && contentLength !== String(asset.size))) throw invalid();
    // Node's Fetch body supports asynchronous iteration, which streams the immutable response without buffering it.
    return await use(response.body as unknown as AsyncIterable<Uint8Array>, connection);
  } finally { await response.body?.cancel().catch(() => undefined); }
}

export function inspectObjects(service: ObjectService, request = fetch): Reader {
  return {
    async inspect(asset) {
      try { return await withObjectAsset(service, asset, (bytes) => hash(bytes, asset.size), request); }
      catch { throw invalid(); }
    },
    close: async () => {},
  };
}

export async function consumeVerifiedAsset<T>(
  asset: MigrationAsset, input: AsyncIterable<Uint8Array>, signal: AbortSignal, consume: ConsumeAsset<T>,
) {
  let complete = false;
  async function* verify() {
    const digest = createHash('sha256');
    let byteLength = 0;
    try {
      for await (const chunk of input) {
        signal.throwIfAborted();
        byteLength += chunk.byteLength;
        if (byteLength > asset.size) throw invalid();
        digest.update(chunk);
        yield chunk;
      }
    } catch { throw invalid(); }
    if (byteLength !== asset.size || digest.digest('hex') !== asset.sha256) throw invalid();
    complete = true;
  }
  const bytes = verify();
  try {
    const result = await consume(bytes, signal);
    if (!complete) throw invalid();
    return result;
  } finally { await bytes.return(undefined); }
}

export type VerifiedSourceAsset = { key: string; kind: SourceAsset['kind']; sourceLength: string | null;
  byteLength: number | null; sha256: string | null };

export async function reconcileAssets(reader: Reader, manifest: ReadonlyMap<string, MigrationAsset>,
  source: ReadonlyMap<string, SourceAsset>, observe?: (entry: VerifiedSourceAsset) => void) {
  try {
    const results = { present: 0, missingOriginals: 0, missingDerivatives: 0, bytes: 0n };
    for (const key of manifest.keys()) {
      if (!source.has(key)) throw invalid();
    }
    for (const [key, expected] of source) {
      keyComponents(key);
      if (assetKeyKind(key) !== expected.kind) throw invalid();
      const declared = manifest.get(key);
      const observed = declared && await reader.inspect(declared);
      const sourceLength = expected.sourceLength?.toString() ?? null;
      if (!declared || !observed) {
        observe?.({ key, kind: expected.kind, sourceLength, byteLength: null, sha256: null });
        if (expected.kind === 'original') results.missingOriginals += 1;
        else results.missingDerivatives += 1;
        continue;
      }
      if (observed.length !== declared.size || observed.digest !== declared.sha256
        || expected.sourceLength !== null && expected.sourceLength !== BigInt(observed.length)) throw invalid();
      observe?.({ key, kind: expected.kind, sourceLength, byteLength: observed.length, sha256: observed.digest });
      results.present += 1;
      results.bytes += BigInt(observed.length);
    }
    return results;
  } finally { await reader.close(); }
}
