import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute, normalize } from 'node:path';
import { anchoredDirectory, fdPath, type Owner } from '../backup/archive.js';
import { assetKeyKind, assetManifestLimit, captureManifestLimit, keyComponents, MigrationError,
  readAssetManifest, readCaptureManifest, sha256 } from './manifest.js';
import { scanTar } from './tar-reader.js';

const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = constants;
type Part = { sha256: string; size: number; magic: Buffer };
const manifestName = 'manifest.json';
const assetsName = 'asset-manifest.json';
const dumps = ['source.dump', 'source.sql'] as const;
type Dump = (typeof dumps)[number];
const customMagic = Buffer.from('PGDMP');

function invalid() {
  return new MigrationError('archive-layout', 'Use a private migration bundle with the two manifests and one supported dump.');
}

function changed() {
  return new MigrationError('capture-integrity', 'The migration archive is incomplete or differs from its capture.');
}

export async function openMigrationFile(path: string, owner: Owner) {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/') throw invalid();
  const leaf = basename(path);
  keyComponents(leaf);
  const parent = await anchoredDirectory(dirname(path), owner, 0o700);
  let file: FileHandle | undefined;
  try {
    file = await open(join(fdPath(parent), leaf), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner.uid || stat.gid !== owner.gid || (stat.mode & 0o077) !== 0) throw invalid();
    return { file, stat };
  } catch (error) {
    await file?.close();
    throw error;
  } finally { await parent.close(); }
}

function sameFile(previous: Stats, current: Stats) {
  return previous.dev === current.dev && previous.ino === current.ino && previous.size === current.size
    && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs;
}

function allowed(input: string, kind: 'file' | 'directory') {
  if (kind === 'directory') {
    if (input === 'assets' || input.startsWith('assets/')) return;
  } else {
    if (input === manifestName || input === assetsName || dumps.some((dump) => dump === input)) return;
    if (input.startsWith('assets/')) {
      assetKeyKind(input.slice('assets/'.length));
      return;
    }
  }
  throw invalid();
}

async function part(size: number, chunks: AsyncIterable<Buffer>, file?: FileHandle, bufferLimit?: number) {
  if (bufferLimit !== undefined && size > bufferLimit) throw invalid();
  const hash = createHash('sha256');
  const buffered: Buffer[] = [];
  let magic = Buffer.alloc(0);
  for await (const chunk of chunks) {
    if (magic.length < customMagic.length) magic = Buffer.concat([magic, chunk.subarray(0, customMagic.length - magic.length)]);
    hash.update(chunk);
    if (bufferLimit !== undefined) buffered.push(chunk);
    await file?.writeFile(chunk);
  }
  return { metadata: { size, sha256: hash.digest('hex'), magic } satisfies Part,
    buffered: bufferLimit === undefined ? undefined : Buffer.concat(buffered, size) };
}

async function verifyArchive(file: FileHandle, signal?: AbortSignal) {
  const members = new Map<string, Part>();
  const directories: string[] = [];
  let captureBytes: Buffer | undefined;
  let assetsBytes: Buffer | undefined;
  await scanTar(file, async ({ path, kind, size }, chunks) => {
    allowed(path, kind);
    if (kind === 'directory') { directories.push(path); return; }
    const limit = path === manifestName ? captureManifestLimit : path === assetsName ? assetManifestLimit : undefined;
    const { metadata, buffered } = await part(size, chunks, undefined, limit);
    members.set(path, metadata);
    if (path === manifestName) captureBytes = buffered;
    if (path === assetsName) assetsBytes = buffered;
  }, signal);
  const dumpNames = dumps.filter((name) => members.has(name));
  if (!captureBytes || !assetsBytes || dumpNames.length !== 1) throw invalid();
  const capture = readCaptureManifest(captureBytes);
  const dump = dumpNames[0];
  const dumpPart = members.get(dump)!;
  if (!dumpPart.size || dumpPart.sha256 !== capture.source.dumpSha256 || dumpPart.magic.equals(customMagic) !== (dump === 'source.dump')) throw changed();
  const assets = readAssetManifest(assetsBytes, capture);
  if (members.size !== 3 + (capture.asset.kind === 'directory' ? assets.size : 0)) throw changed();
  if (capture.asset.kind === 'directory') for (const [key, expected] of assets) {
    const actual = members.get('assets/' + key);
    if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) throw changed();
  }
  const parents = new Set<string>(capture.asset.kind === 'directory' ? ['assets'] : []);
  for (const name of members.keys()) {
    const components = name.split('/');
    for (let i = 1; i < components.length; i++) parents.add(components.slice(0, i).join('/'));
  }
  if (directories.some((name) => !parents.has(name))) throw invalid();
  return { capture, dump, members, parents, manifestSha256: sha256(captureBytes) };
}

async function syncDirectory(path: string) {
  const directory = await open(path, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function publish(root: FileHandle, pending: string, finalName: string) {
  const staged = await lstat(join(fdPath(root), pending));
  const result = spawnSync('/usr/bin/mv', ['--no-clobber', '--no-target-directory', '--',
    '/proc/self/fd/3/' + pending, '/proc/self/fd/3/' + finalName], {
    stdio: ['ignore', 'ignore', 'ignore', root.fd], timeout: 15_000,
  });
  const published = await lstat(join(fdPath(root), finalName)).catch(() => undefined);
  if (result.status !== 0 || !published || staged.dev !== published.dev || staged.ino !== published.ino) throw changed();
  await root.sync();
}

export async function prepareMigration(archive: string, workDir: string, owner: Owner, signal?: AbortSignal) {
  const { file, stat } = await openMigrationFile(archive, owner);
  let root: FileHandle | undefined;
  let pending: string | undefined;
  let owned: Stats | undefined;
  try {
    const verified = await verifyArchive(file, signal);
    if (!sameFile(stat, await file.stat())) throw changed();
    signal?.throwIfAborted();

    root = await anchoredDirectory(workDir, owner, 0o700);
    const name = 'capture-' + randomUUID();
    const temporary = '.' + name;
    pending = join(fdPath(root), temporary);
    await mkdir(pending, { mode: 0o700 });
    owned = await lstat(pending);

    for (const directory of [...verified.parents].sort()) await mkdir(join(pending, directory), { mode: 0o700 });
    const copied = new Set<string>();
    await scanTar(file, async ({ path, kind, size }, chunks) => {
      if (kind === 'directory') {
        if (!verified.parents.has(path)) throw changed();
        return;
      }
      const expected = verified.members.get(path);
      if (!expected || expected.size !== size) throw changed();
      const output = await open(join(pending!, path), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      try {
        const { metadata } = await part(size, chunks, output);
        if (metadata.sha256 !== expected.sha256) throw changed();
        await output.sync();
        copied.add(path);
      } finally { await output.close(); }
    }, signal);
    if (copied.size !== verified.members.size || !sameFile(stat, await file.stat())) throw changed();
    for (const directory of [...verified.parents].sort().reverse()) await syncDirectory(join(pending, directory));
    await syncDirectory(pending);
    signal?.throwIfAborted();
    await publish(root, temporary, name);
    const directory = join(workDir, name);
    return { directory, manifest: join(directory, manifestName), dump: join(directory, verified.dump satisfies Dump),
      manifestSha256: verified.manifestSha256, assets: verified.capture.asset.kind === 'directory' ? join(directory, 'assets') : null };
  } finally {
    try {
      if (owned && pending) {
        const candidate = await lstat(pending).catch(() => undefined);
        if (candidate?.ino === owned.ino && candidate.dev === owned.dev) await rm(pending, { recursive: true, force: true });
      }
    } finally { await Promise.allSettled([file.close(), root?.close()]); }
  }
}
