import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationAsset, MigrationCapture } from '@planner/contracts';
import { anchoredDirectory, fdPath, fileChunks, type Owner } from '../backup/archive.js';
import { assetKeyKind, keyComponents, MigrationError, registerPath } from './manifest.js';
import type { SourceAsset } from './source-reader.js';
import { migrationServiceName } from './source-service.js';

const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = constants;
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
    const entries = await readdir(fdPath(parent), { withFileTypes: true });
    for (const entry of entries) {
      total += 1;
      if (total > 200_000) throw invalid();
      const key = prefix + entry.name;
      registerPath(known, key);
      const path = join(fdPath(parent), entry.name);
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

export function inspectObjects(service: ObjectService, request = fetch): Reader {
  return {
    async inspect(asset) {
      if (!asset.versionId) throw invalid();
      const item = new URL(asset.key.split('/').map(encodeURIComponent).join('/'), service.base);
      item.searchParams.set('versionId', asset.versionId);
      try {
        const response = await request(item, {
          redirect: 'error', signal: AbortSignal.timeout(35_000),
          headers: { 'Accept-Encoding': 'identity', ...(service.token && { Authorization: 'Bearer ' + service.token }) },
        });
        if (response.status === 404) { await response.body?.cancel(); return null; }
        const contentLength = response.headers.get('content-length');
        const encoding = response.headers.get('content-encoding');
        if (response.status !== 200 || !response.body || response.headers.get('x-amz-version-id') !== asset.versionId
          || (encoding && encoding !== 'identity') || (contentLength !== null && contentLength !== String(asset.size))) {
          await response.body?.cancel();
          throw invalid();
        }
        // Node's Fetch body supports asynchronous iteration, which streams the immutable response without buffering it.
        return await hash(response.body as unknown as AsyncIterable<Uint8Array>, asset.size);
      } catch {
        throw invalid();
      }
    },
    close: async () => {},
  };
}

export async function reconcileAssets(reader: Reader, manifest: ReadonlyMap<string, MigrationAsset>, source: ReadonlyMap<string, SourceAsset>) {
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
      if (!declared || !observed) {
        if (expected.kind === 'original') results.missingOriginals += 1;
        else results.missingDerivatives += 1;
        continue;
      }
      if (observed.length !== declared.size || observed.digest !== declared.sha256
        || expected.sourceLength !== null && expected.sourceLength !== BigInt(observed.length)) throw invalid();
      results.present += 1;
      results.bytes += BigInt(observed.length);
    }
    return results;
  } finally { await reader.close(); }
}
