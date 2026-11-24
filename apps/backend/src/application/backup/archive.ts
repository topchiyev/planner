import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { generationIdSchema, installationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import { currentStorageSchema } from '../../storage/schema.js';
import { workspaceCollections } from '../../storage/catalog.js';

const { O_RDONLY, O_RDWR, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK, O_CREAT, O_EXCL } = constants;
export const backupCollections = ['installation', ...workspaceCollections].sort();
const maximumManifestBytes = 32 * 1024 * 1024;
export const digestPattern = /^[0-9a-f]{64}$/u;

export class BackupError extends Error {
  constructor(message = 'The Planner backup is invalid or unavailable.') { super(message); }
}

export type Part = { sha256: string; byteLength: number };
export type CollectionPart = Part & { name: string; rows: number };
export type BackupManifest = {
  format: 1;
  backupId: string;
  installationId: string;
  activeGenerationId: string;
  schemaVersion: number;
  createdAt: string;
  collections: CollectionPart[];
  blobs: Part[];
  secrets: Part;
};
export type Owner = { uid: number; gid: number };
export function optionalStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}
const own = (stat: Stats, owner: Owner) => stat.uid === owner.uid && stat.gid === owner.gid;
export const fdPath = ({ fd }: FileHandle) => `/proc/self/fd/${fd}`;
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n', 'utf8');
export const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function part(value: unknown): value is Part & Record<string, unknown> {
  return object(value) && typeof value.sha256 === 'string' && digestPattern.test(value.sha256) && count(value.byteLength);
}

export function parseManifest(bytes: Buffer): BackupManifest {
  try {
    if (!bytes.length || bytes.length > maximumManifestBytes) throw new BackupError();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || !keys(value, ['format', 'backupId', 'installationId', 'activeGenerationId', 'schemaVersion',
      'createdAt', 'collections', 'blobs', 'secrets']) || value.format !== 1 || value.schemaVersion !== currentStorageSchema
      || !publicIdSchema.safeParse(value.backupId).success || !installationIdSchema.safeParse(value.installationId).success
      || !generationIdSchema.safeParse(value.activeGenerationId).success || typeof value.createdAt !== 'string'
      || new Date(value.createdAt).toISOString() !== value.createdAt || !Array.isArray(value.collections)
      || value.collections.length !== backupCollections.length || !Array.isArray(value.blobs)
      || !part(value.secrets) || !keys(value.secrets, ['sha256', 'byteLength']) || value.secrets.byteLength > 8192) throw new BackupError();
    for (const [i, entry] of value.collections.entries()) {
      if (!object(entry) || !keys(entry, ['name', 'rows', 'sha256', 'byteLength']) || !count(entry.rows)
        || !part(entry) || entry.name !== backupCollections[i] || (entry.rows === 0) !== (entry.byteLength === 0)
        || (entry.name === 'installation' && entry.rows !== 1)) throw new BackupError();
    }
    let previous = '';
    for (const blob of value.blobs) {
      if (!part(blob) || !keys(blob, ['sha256', 'byteLength']) || blob.sha256 <= previous) throw new BackupError();
      previous = blob.sha256;
    }
    return value as BackupManifest;
  } catch { throw new BackupError('The Planner backup manifest is invalid or unsupported.'); }
}

async function openDirectory(path: string) {
  return open(path, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
}

// A descriptor anchors each component before the next component is opened. No input directory can redirect a later lookup.
export async function anchoredDirectory(path: string, owner: Owner, mode: number) {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/') throw new BackupError('Use an absolute private backup directory.');
  const components = path.slice(1).split('/');
  let directory = await openDirectory('/');
  try {
    for (const [index, component] of components.entries()) {
      const next = await openDirectory(`${fdPath(directory)}/${component}`);
      await directory.close();
      directory = next;
      const stat = await directory.stat();
      const last = index === components.length - 1;
      if (last ? !own(stat, owner) || (stat.mode & 0o7777) !== mode
        : (stat.uid !== 0 && stat.uid !== owner.uid) || (stat.mode & 0o022) !== 0) {
        throw new BackupError('The backup directory or an ancestor has unsafe ownership or permissions.');
      }
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

function validName(value: string) {
  if (!/^[a-zA-Z0-9.-]+$/u.test(value) || value === '.' || value === '..') throw new BackupError();
  return value;
}
export const childPath = (directory: FileHandle, name: string) => `${fdPath(directory)}/${validName(name)}`;

async function verifyFile(directory: FileHandle, name: string, owner: Owner) {
  const file = await open(childPath(directory, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !own(stat, owner) || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) throw new BackupError();
    return { file, stat };
  } catch (error) { await file.close(); throw error; }
}
async function verifyDirectory(directory: FileHandle, name: string, owner: Owner) {
  const child = await openDirectory(childPath(directory, name));
  try {
    const stat = await child.stat();
    if (!own(stat, owner) || (stat.mode & 0o7777) !== 0o700) throw new BackupError();
    return child;
  } catch (error) { await child.close(); throw error; }
}

async function contents(file: FileHandle, stat: Stats, limit: number) {
  if (stat.size > limit) throw new BackupError();
  const buffers: Buffer[] = [];
  for await (const chunk of fileChunks(file, stat.size)) buffers.push(chunk);
  return Buffer.concat(buffers, stat.size);
}

async function writePart(directory: FileHandle, name: string, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Part> {
  const file = await open(childPath(directory, name), O_RDWR | O_NOFOLLOW | O_EXCL | O_CREAT, 0o600);
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for await (const chunk of chunks) {
      await file.writeFile(chunk);
      hash.update(chunk);
      byteLength += chunk.byteLength;
      if (!Number.isSafeInteger(byteLength)) throw new BackupError();
    }
    await file.sync();
    return { sha256: hash.digest('hex'), byteLength };
  } finally { await file.close(); }
}

export async function* fileChunks(file: FileHandle, size: number) {
  let offset = 0;
  while (offset < size) {
    const buffer = Buffer.allocUnsafe(Math.min(size - offset, 128 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) throw new BackupError();
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
  if ((await file.stat()).size !== size) throw new BackupError();
}

export async function verifyPart(file: FileHandle, expected: Part) {
  const hash = createHash('sha256');
  for await (const chunk of fileChunks(file, expected.byteLength)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) throw new BackupError('A Planner backup part checksum does not match the manifest.');
}

async function ensureEntries(directory: FileHandle, names: string[]) {
  const entries = await readdir(fdPath(directory));
  const allowed = new Set(names);
  if (entries.length !== allowed.size || entries.some((name) => !allowed.has(name))) {
    throw new BackupError('The Planner backup directory has unexpected or missing entries.');
  }
}

async function readBundle(root: FileHandle, owner: Owner, fingerprint: string) {
  const opened = await verifyFile(root, 'manifest.json', owner);
  let manifest: BackupManifest;
  try {
    const bytes = await contents(opened.file, opened.stat, maximumManifestBytes);
    if (!digestPattern.test(fingerprint) || sha256(bytes) !== fingerprint) throw new BackupError('The expected Planner backup manifest does not match.');
    manifest = parseManifest(bytes);
  } finally { await opened.file.close(); }
  await ensureEntries(root, ['manifest.json', 'secrets.json', 'db', 'blobs']);
  const db = await verifyDirectory(root, 'db', owner);
  let blobs: FileHandle | undefined;
  try {
    blobs = await verifyDirectory(root, 'blobs', owner);
    await ensureEntries(db, manifest.collections.map(({ name }) => `${name}.bson`));
    await ensureEntries(blobs, manifest.blobs.map(({ sha256: digest }) => digest));
    return { manifest, db, blobs };
  } catch (error) { await Promise.allSettled([db.close(), blobs?.close()]); throw error; }
}

async function checkedBundle(root: FileHandle, owner: Owner, fingerprint: string) {
  const { manifest, db, blobs } = await readBundle(root, owner, fingerprint);
  async function partFile(directory: FileHandle, name: string, expected: Part) {
    const { file, stat } = await verifyFile(directory, name, owner);
    if (stat.size !== expected.byteLength) { await file.close(); throw new BackupError('A Planner backup part length does not match the manifest.'); }
    return file;
  }
  const collection = (entry: CollectionPart) => partFile(db, `${entry.name}.bson`, entry);
  const blob = (entry: Part) => partFile(blobs, entry.sha256, entry);
  const secrets = () => partFile(root, 'secrets.json', manifest.secrets);
  const close = async () => { await Promise.all([db.close(), blobs.close()]); };
  try {
    for (const entry of manifest.collections) {
      const file = await collection(entry);
      try { await verifyPart(file, entry); } finally { await file.close(); }
    }
    for (const entry of manifest.blobs) {
      const file = await blob(entry);
      try { await verifyPart(file, entry); } finally { await file.close(); }
    }
    const file = await secrets();
    try { await verifyPart(file, manifest.secrets); } finally { await file.close(); }
    return { manifest, collection, blob, secrets, close };
  } catch (error) { await close(); throw error; }
}

export async function openBackup(path: string, owner: Owner, fingerprint: string) {
  const root = await anchoredDirectory(path, owner, 0o700);
  try {
    const bundle = await checkedBundle(root, owner, fingerprint);
    return { ...bundle, close: async () => { try { await bundle.close(); } finally { await root.close(); } } };
  } catch (error) { await root.close(); throw error; }
}

export async function publishBackup(
  path: string, owner: Owner, capture: (writer: {
    collection: (name: string, chunks: AsyncIterable<Buffer>) => Promise<Part>;
    blob: (digest: string, chunks: AsyncIterable<Buffer>) => Promise<Part>;
    secrets: (contents: Buffer) => Promise<Part>;
  }) => Promise<Omit<BackupManifest, 'format' | 'backupId'>>,
) {
  const root = await anchoredDirectory(path, owner, 0o700);
  const backupId = randomUUID();
  const pending = childPath(root, `.capture-${backupId}`);
  const published = childPath(root, backupId);
  let created = false;
  let complete = false;
  let directory: FileHandle | undefined;
  let db: FileHandle | undefined;
  let blobs: FileHandle | undefined;
  try {
    await mkdir(pending, { mode: 0o700 });
    created = true;
    directory = await openDirectory(pending);
    for (const entry of ['db', 'blobs']) await mkdir(childPath(directory, entry), { mode: 0o700 });
    db = await openDirectory(childPath(directory, 'db'));
    blobs = await openDirectory(childPath(directory, 'blobs'));
    const manifest: BackupManifest = { format: 1, backupId, ...await capture({
      collection: (name, chunks) => writePart(db!, `${name}.bson`, chunks),
      blob: (digest, chunks) => writePart(blobs!, digest, chunks),
      secrets: (contents) => writePart(directory!, 'secrets.json', [contents]),
    }) };
    await Promise.all([db.sync(), blobs.sync()]);
    const fingerprint = (await writePart(directory, 'manifest.json', [json(manifest)])).sha256;
    const checked = await checkedBundle(directory, owner, fingerprint);
    await checked.close();
    await directory.sync();
    if (await optionalStat(published)) throw new BackupError();
    await rename(pending, published);
    complete = true;
    await root.sync();
    return { backupId, manifestSha256: fingerprint };
  } finally {
    await Promise.allSettled([db?.close(), blobs?.close(), directory?.close()]);
    try {
      if (created && !complete) await rm(pending, { recursive: true, force: true });
    } finally { await root.close(); }
  }
}
