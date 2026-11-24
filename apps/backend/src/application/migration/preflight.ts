import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { dirname, join, isAbsolute, normalize } from 'node:path';
import type { Owner } from '../backup/archive.js';
import { BackupError, fileChunks } from '../backup/archive.js';
import { inspectDirectory, inspectObjects, parseObjectService, reconcileAssets } from './assets.js';
import { assetManifestLimit, captureManifestLimit, MigrationError, readAssetManifest, readCaptureManifest, sha256 } from './manifest.js';
import { openMigrationFile } from './prepare.js';
import { finishSourceFingerprint, fingerprintRows, startAssetFingerprint, type SourceFingerprint } from './source-fingerprint.js';
import { readSourceBatch, type SourceBatch, type SourceTable } from './source-projections.js';
import { sourcePreflightInSnapshot, withSourceSnapshot } from './source-reader.js';
import { migrationServiceName, parseSourceService } from './source-service.js';

export type MigrationInput = { manifest: string; sourceService: string } & (
  { assetsRoot: string; assetService?: never } | { assetsRoot?: never; assetService: string }
);

export function migrationPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value !== '/' && normalize(value) === value
    && Buffer.byteLength(value) < 4096 && !/[\p{Cc}]/u.test(value);
}

export function parseMigrationInput(value: unknown): MigrationInput {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || !('manifest' in value)
      || !migrationPath(value.manifest) || !('sourceService' in value) || typeof value.sourceService !== 'string'
      || !migrationServiceName.test(value.sourceService)) throw new MigrationError('capture-format', 'Specify a private capture and a protected source service.');
  const { manifest, sourceService } = value;
  if ('assetsRoot' in value && migrationPath(value.assetsRoot)) return { manifest, sourceService, assetsRoot: value.assetsRoot };
  if ('assetService' in value && typeof value.assetService === 'string' && migrationServiceName.test(value.assetService))
    return { manifest, sourceService, assetService: value.assetService };
  throw new MigrationError('asset-manifest', 'Select exactly one directory or immutable object asset source.');
}

async function smallFile(path: string, owner: Owner, limit: number) {
  const { file, stat } = await openMigrationFile(path, owner);
  try {
    if (!stat.size || stat.size > limit) throw new MigrationError('capture-format', 'The migration input exceeds its manifest size limit.');
    const chunks: Buffer[] = [];
    for await (const chunk of fileChunks(file, stat.size)) chunks.push(chunk);
    const after = await file.stat();
    if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new MigrationError('capture-integrity', 'The migration input changed during preflight.');
    return Buffer.concat(chunks, stat.size);
  } finally { await file.close(); }
}

async function verifyDump(directory: string, owner: Owner, expected: string) {
  const names = ['source.dump', 'source.sql'] as const;
  const files = await Promise.all(names.map(async (name) => {
    try { return await openMigrationFile(join(directory, name), owner); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      return error;
    }
  }));
  function opened(entry: unknown): entry is Awaited<ReturnType<typeof openMigrationFile>> {
    return !!entry && typeof entry === 'object' && 'file' in entry && 'stat' in entry;
  }
  try {
    const usable = files.filter(opened);
    if (usable.length !== 1 || files.some((entry) => entry !== null && !opened(entry)))
      throw new MigrationError('capture-integrity', 'Keep exactly one verified dump alongside the capture manifests.');
    const { file, stat } = usable[0];
    const kind = files[0] ? 'custom' : 'sql';
    if (!stat.size || stat.size > 64 * 1024 ** 3)
      throw new MigrationError('capture-integrity', 'The source dump has an invalid or unsupported size.');
    const signature = Buffer.alloc(5);
    await file.read(signature, 0, signature.length, 0);
    if (signature.equals(Buffer.from('PGDMP')) !== (kind === 'custom'))
      throw new MigrationError('capture-integrity', 'The source dump kind differs from its capture layout.');
    const digest = createHash('sha256');
    for await (const chunk of fileChunks(file, stat.size)) digest.update(chunk);
    const after = await file.stat();
    if (digest.digest('hex') !== expected || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new MigrationError('capture-integrity', 'The source dump checksum differs from the capture.');
    return { kind, byteLength: String(stat.size) };
  } finally { await Promise.allSettled(files.filter(opened).map(({ file }) => file.close())); }
}

async function whileReadingAssets<T>(client: Client, verify: () => Promise<T>) {
  let heartbeat: Promise<unknown> | undefined;
  let failure: unknown;
  const timer = setInterval(() => {
    if (heartbeat || failure) return;
    heartbeat = client.query('SELECT 1').catch((error: unknown) => { failure = error; })
      .finally(() => { heartbeat = undefined; });
  }, 15_000);
  timer.unref();
  try {
    const result = await verify();
    if (heartbeat) await heartbeat;
    if (failure) throw failure;
    return result;
  } finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
  }
}

const admittedSnapshots = new WeakSet<VerifiedSourceSnapshot>();
export type VerifiedSourceSnapshot = {
  readonly fingerprint: SourceFingerprint;
  readBatch<T extends SourceTable>(table: T, lastSourceId: string | null, limit: number): Promise<SourceBatch<T>>;
};

export function assertVerifiedSourceSnapshot(snapshot: VerifiedSourceSnapshot) {
  if (!admittedSnapshots.has(snapshot))
    throw new MigrationError('source-changed', 'Open and verify the source snapshot before writing a batch.');
}

export async function withMigrationSnapshot<T>(
  input: MigrationInput, owner: Owner, sourceConfig: string, objectConfig: string | undefined,
  options: { expectedFingerprint?: string; batchSize?: number },
  read: (snapshot: VerifiedSourceSnapshot) => Promise<T>,
) {
  try {
    const raw = await smallFile(input.manifest, owner, captureManifestLimit);
    const capture = readCaptureManifest(raw);
    const directory = dirname(input.manifest);
    const manifestSha256 = sha256(raw);
    const dump = await verifyDump(directory, owner, capture.source.dumpSha256);
    const assets = readAssetManifest(await smallFile(join(directory, 'asset-manifest.json'), owner, assetManifestLimit), capture);
    const service = parseSourceService(sourceConfig, input.sourceService);
    const objectService = input.assetService !== undefined ? parseObjectService(objectConfig ?? '', input.assetService, capture) : undefined;
    if ((capture.asset.kind === 'directory') !== (input.assetsRoot !== undefined)) {
      throw new MigrationError('asset-manifest', 'The declared capture does not match the selected asset source.');
    }
    const { value, restoredPostgresVersion } = await withSourceSnapshot(service, async (client) => {
      const source = await sourcePreflightInSnapshot(client);
      const rowDigest = await fingerprintRows(client, source.rows, options.batchSize);
      const assetFingerprint = startAssetFingerprint();
      const assetSummary = await whileReadingAssets(client, async () => {
        const reader = objectService ? inspectObjects(objectService) : await inspectDirectory(input.assetsRoot!, owner, assets);
        return reconcileAssets(reader, assets, source.assets, assetFingerprint.observe);
      });
      const fingerprint = finishSourceFingerprint(capture, rowDigest, assetFingerprint.finish());
      if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== fingerprint.sha256)
        throw new MigrationError('source-changed', 'The source snapshot changed. Start a new import run.');
      const rows = Object.values(source.rows).reduce((sum, count) => sum + BigInt(count), 0n);
      Object.freeze(fingerprint.components);
      const pendingReads = new Set<Promise<unknown>>();
      let readFailure: unknown;
      const snapshot: VerifiedSourceSnapshot = Object.freeze({
        fingerprint: Object.freeze(fingerprint),
        readBatch<T extends SourceTable>(table: T, lastSourceId: string | null, limit: number) {
          assertVerifiedSourceSnapshot(snapshot);
          const result = readSourceBatch(client, table, lastSourceId, limit);
          pendingReads.add(result);
          void result.then(
            () => pendingReads.delete(result),
            (error: unknown) => { readFailure ??= error; pendingReads.delete(result); },
          );
          return result;
        },
      });
      admittedSnapshots.add(snapshot);
      let value: T;
      try { value = await read(snapshot); }
      finally {
        admittedSnapshots.delete(snapshot);
        await Promise.allSettled(pendingReads);
      }
      if (readFailure !== undefined) throw readFailure;
      return {
        manifestSha256, capture, dump, fingerprint, rows: source.rows,
        estimates: { sourceBytes: source.dataBytes, sourceIndexes: source.indexBytes, sourceRows: rows, assetBytes: assetSummary.bytes },
        assets: { present: assetSummary.present, missingOriginals: assetSummary.missingOriginals, missingDerivatives: assetSummary.missingDerivatives },
        value,
      };
    });
    return { ...value, restoredPostgresVersion };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (error instanceof BackupError)
      throw new MigrationError('capture-integrity', 'The migration input could not be verified in its private directory.');
    throw new MigrationError('capture-integrity', 'The protected migration input is unavailable or changed during verification.');
  }
}


export async function inspectMigration(input: MigrationInput, owner: Owner, sourceConfig: string, objectConfig?: string) {
  const { value: _value, ...receipt } = await withMigrationSnapshot(input, owner, sourceConfig, objectConfig, {}, async () => undefined);
  return receipt;
}
