import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { dirname, join, isAbsolute, normalize } from 'node:path';
import type { Owner } from '../backup/archive.js';
import { BackupError, fileChunks } from '../backup/archive.js';
import { consumeVerifiedAsset, inspectDirectory, inspectObjects, parseObjectService, reconcileAssets, withDirectoryAsset, withObjectAsset,
  type VerifiedSourceAsset } from './assets.js';
import { assetManifestLimit, captureManifestLimit, MigrationError, readAssetManifest, readCaptureManifest, sha256 } from './manifest.js';
import { openMigrationFile } from './prepare.js';
import { finishSourceFingerprint, fingerprintRows, startAssetFingerprint, type SourceFingerprint } from './source-fingerprint.js';
import { readSourceBatch, readSourceUpload, type SourceBatch, type SourceRow, type SourceTable } from './source-projections.js';
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

async function whileSnapshotWork<T>(client: Client, verify: () => Promise<T>) {
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

type SnapshotOperations = { accepting: boolean; pending: Set<Promise<unknown>>; failure?: unknown };
const admittedSnapshots = new WeakMap<VerifiedSourceSnapshot, SnapshotOperations>();
export type VerifiedSourceSnapshot = {
  readonly fingerprint: SourceFingerprint;
  readonly capture: Readonly<{ capturedAt: string; sourceInstanceId: string }>;
  readonly manifestSha256: string;
  readonly sourceCounts: Readonly<Record<string, string>>;
  assets(): Iterable<Readonly<VerifiedSourceAsset>>;
  readBatch<T extends SourceTable>(table: T, lastSourceId: string | null, limit: number): Promise<SourceBatch<T>>;
  readUpload(id: string): Promise<SourceRow<'uploaded_file'> | null>;
  asset(key: string): Readonly<VerifiedSourceAsset>;
  readAsset<T>(key: string, signal: AbortSignal, consume: (bytes: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<T>): Promise<T>;
};

export function assertVerifiedSourceSnapshot(snapshot: VerifiedSourceSnapshot, accepting = false) {
  const operations = admittedSnapshots.get(snapshot);
  if (!operations || (accepting && !operations.accepting))
    throw new MigrationError('source-changed', 'Open and verify the source snapshot before reading or writing a batch.');
  return operations;
}

export function trackSourceOperation<T>(snapshot: VerifiedSourceSnapshot, run: () => Promise<T>) {
  const operations = assertVerifiedSourceSnapshot(snapshot, true);
  const started = run();
  operations.pending.add(started);
  void started.then(
    () => operations.pending.delete(started),
    (error: unknown) => { operations.failure ??= error; operations.pending.delete(started); },
  );
  return started;
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
      const verifiedAssets = new Map<string, Readonly<VerifiedSourceAsset>>();
      const assetSummary = await whileSnapshotWork(client, async () => {
        const reader = objectService ? inspectObjects(objectService) : await inspectDirectory(input.assetsRoot!, owner, assets);
        return reconcileAssets(reader, assets, source.assets, (entry) => {
          assetFingerprint.observe(entry);
          verifiedAssets.set(entry.key, Object.freeze(entry));
        });
      });
      const fingerprint = finishSourceFingerprint(capture, rowDigest, assetFingerprint.finish());
      if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== fingerprint.sha256)
        throw new MigrationError('source-changed', 'The source snapshot changed. Start a new import run.');
      const rows = Object.values(source.rows).reduce((sum, count) => sum + BigInt(count), 0n);
      Object.freeze(fingerprint.components);
      const operations: SnapshotOperations = { accepting: true, pending: new Set() };
      const snapshot: VerifiedSourceSnapshot = Object.freeze({
        fingerprint: Object.freeze(fingerprint),
        capture: Object.freeze({ capturedAt: capture.capturedAt, sourceInstanceId: capture.source.instanceId }),
        manifestSha256,
        sourceCounts: Object.freeze(source.rows),
        assets() {
          assertVerifiedSourceSnapshot(snapshot, true);
          return verifiedAssets.values();
        },
        readBatch<T extends SourceTable>(table: T, lastSourceId: string | null, limit: number) {
          return trackSourceOperation(snapshot, () => readSourceBatch(client, table, lastSourceId, limit));
        },
        readUpload(id: string) {
          return trackSourceOperation(snapshot, () => readSourceUpload(client, id));
        },
        asset(key: string) {
          assertVerifiedSourceSnapshot(snapshot, true);
          const verified = verifiedAssets.get(key);
          if (!verified) throw new MigrationError('asset-integrity', 'The asset is outside the verified source inventory.');
          return verified;
        },
        readAsset<T>(key: string, signal: AbortSignal,
          receive: (bytes: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<T>) {
          return trackSourceOperation(snapshot, async () => {
            const verified = snapshot.asset(key);
            const declared = assets.get(key);
            if (!declared || verified.sha256 === null || verified.byteLength === null)
              throw new MigrationError('asset-integrity', 'The source asset was unavailable in the verified snapshot.');
            const consume = async (bytes: AsyncIterable<Uint8Array>, reading: AbortSignal) =>
              ({ value: await consumeVerifiedAsset(declared, bytes, reading, receive) });
            const read = objectService ? await withObjectAsset(objectService, declared, consume, undefined, signal)
              : await withDirectoryAsset(input.assetsRoot!, owner, declared, consume, signal);
            if (!read) throw new MigrationError('asset-integrity', 'The source asset disappeared after verification.');
            return read.value;
          });
        },
      });
      admittedSnapshots.set(snapshot, operations);
      const value = await whileSnapshotWork(client, async () => {
        try { return await read(snapshot); }
        finally {
          operations.accepting = false;
          await Promise.allSettled(operations.pending);
          admittedSnapshots.delete(snapshot);
        }
      });
      if (operations.failure !== undefined) throw operations.failure;
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
