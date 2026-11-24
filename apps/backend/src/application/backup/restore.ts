import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { nativeInstallationConfig } from '@planner/contracts/native';
import { BSON, type Db, type Document } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { migrateStorageSchema, verifyStorageSchema } from '../../storage/schema.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { durable } from '../command-journal/records.js';
import type { BlobIdentity } from '../../storage/blobs/private-store.js';
import { BackupError, backupCollections, digestPattern, fileChunks, openBackup, sha256,
  type CollectionPart, type Owner, type Part } from './archive.js';
import { archiveRows, destinationRow, digestRawRows, inventoryParts, mediaInventory } from './records.js';

type StoredDocument = Document & { _id: string };

type Restoration = {
  fingerprint: string; installationDigest: string; phase: 'staging' | 'staged' | 'active'; generationId: string;
  inventory?: CollectionPart[]; blobs?: Part[];
};
type Checkpoint = (name: 'row' | 'blob' | 'staged' | 'activated', id: string) => void | Promise<void>;
type RestoreMedia = {
  assertInventory: (entries: readonly Part[]) => Promise<void>;
  writeBlob: (file: FileHandle, entry: Part) => Promise<void>;
  verifyBlob: (identity: BlobIdentity) => Promise<void>;
};

function installationDigest(record: Document) {
  const { activeGenerationId: _active, restoration: _restore, ...stable } = record;
  return sha256(BSON.serialize(stable));
}

function verificationProof(marker: Pick<Restoration, 'fingerprint' | 'generationId' | 'installationDigest' | 'inventory' | 'blobs'>) {
  return sha256(Buffer.from(JSON.stringify({ fingerprint: marker.fingerprint, generationId: marker.generationId,
    installationDigest: marker.installationDigest, inventory: marker.inventory, blobs: marker.blobs }), 'utf8'));
}

export async function inspectBackup(path: string, owner: Owner, fingerprint: string) {
  const archive = await openBackup(path, owner, fingerprint);
  let key: Buffer | undefined;
  try {
    const { manifest } = archive;
    async function readSourceInstallation() {
      const entry = manifest.collections.find(({ name }) => name === 'installation')!;
      const file = await archive.collection(entry);
      try {
        let source: Document | undefined;
        for await (const row of archiveRows(file, entry)) source = row.record;
        if (!source || source.installationId !== manifest.installationId || source.activeGenerationId !== manifest.activeGenerationId
          || Number(source.schemaVersion) !== manifest.schemaVersion || source.schemaMigration !== undefined
          || source.setup?.pendingAction !== 'complete') throw new BackupError('The backup installation identity, state or schema does not match.');
        return source;
      } finally { await file.close(); }
    }
    const source = await readSourceInstallation();
    const secretFile = await archive.secrets();
    let config;
    try {
      const pieces: Buffer[] = [];
      for await (const piece of fileChunks(secretFile, manifest.secrets.byteLength)) pieces.push(piece);
      const buffer = Buffer.concat(pieces);
      try {
        if (sha256(buffer) !== manifest.secrets.sha256) throw new BackupError();
        const value = JSON.parse(buffer.toString('utf8'));
        const checked = nativeInstallationConfig.safeParse(value.config);
        if (Object.keys(value).length !== 3 || value.version !== 1 || !checked.success
          || checked.data.installationId !== manifest.installationId || checked.data.mode !== source.setup.mode
          || typeof value.mfaKey !== 'string' || !digestPattern.test(value.mfaKey)) {
          throw new BackupError('The backup configuration bundle does not match the installation.');
        }
        config = checked.data;
        key = Buffer.from(value.mfaKey, 'hex');
        if (sha256(key) !== source.mfaKeyDigest) throw new BackupError('The backup multifactor key does not match its stored binding.');
      } finally { buffer.fill(0); for (const piece of pieces) piece.fill(0); }
    } finally { await secretFile.close(); }
    const snapshotKey = key!;
    const inventory: CollectionPart[] = [];
    for (const part of manifest.collections) {
      if (part.name === 'installation') continue;
      const file = await archive.collection(part);
      try {
        let rows = 0;
        let byteLength = 0;
        const hash = createHash('sha256');
        for await (const row of archiveRows(file, part)) {
          const retained = destinationRow(part.name, row.record);
          if (!retained) continue;
          const bytes = Buffer.from(BSON.serialize(retained));
          if (retained === row.record && !bytes.equals(row.bytes)) throw new BackupError('A backup BSON row cannot be restored exactly.');
          hash.update(bytes);
          rows += 1;
          byteLength += bytes.length;
        }
        inventory.push({ name: part.name, rows, byteLength, sha256: hash.digest('hex') });
      } finally { await file.close(); }
    }
    const proof = verificationProof({ fingerprint, generationId: manifest.activeGenerationId,
      installationDigest: installationDigest(source), inventory, blobs: manifest.blobs });
    return { archive, source, config, key: snapshotKey, fingerprint, inventory, proof,
      close: async () => { snapshotKey.fill(0); await archive.close(); } };
  } catch (error) { key?.fill(0); await archive.close(); throw error; }
}

export type VerifiedBackup = Awaited<ReturnType<typeof inspectBackup>>;



async function checkCollections(db: Db) {
  const names = await db.listCollections({}, { nameOnly: true }).toArray();
  if (names.some(({ name }) => !backupCollections.includes(name))) throw new BackupError('The restore destination contains foreign MongoDB collections.');
}

async function verifyStaged(db: Db, media: RestoreMedia, marker: Restoration) {
  if (!Array.isArray(marker.inventory) || !Array.isArray(marker.blobs)) throw new BackupError('The staged restore has no verified inventory.');
  await checkCollections(db);
  const collections = backupCollections.filter((name) => name !== 'installation');
  const actual: CollectionPart[] = [];
  for (const name of collections) actual.push(await digestRawRows(db, name));
  if (!isDeepStrictEqual(actual, marker.inventory)) throw new BackupError('The staged MongoDB rows differ from the verified restore inventory.');
  const inventory = await mediaInventory(db, marker.generationId);
  if (!isDeepStrictEqual(inventoryParts(inventory), marker.blobs)) throw new BackupError('The staged media references differ from the verified restore inventory.');
  await media.assertInventory(marker.blobs);
  for (const identity of inventory) await media.verifyBlob(identity);
}

export async function stageRestore(db: Db, writer: WriterLease, media: RestoreMedia, backup: VerifiedBackup, checkpoint?: Checkpoint) {
  writer.assertHeld();
  const { archive, source, fingerprint, inventory } = backup;
  const { manifest } = archive;
  const key = { _id: 'installation', installationId: manifest.installationId } as const;
  const collection = db.collection<StoredDocument>('installation');
  const marker: Restoration = { fingerprint, phase: 'staging', generationId: manifest.activeGenerationId, installationDigest: installationDigest(source) };
  await checkCollections(db);
  const saved = await collection.findOne(key);
  if (!saved) throw new BackupError('The restore destination has a different installation identity.');
  if (saved.activeGenerationId != null) throw new BackupError('Refusing to replace an active Planner installation.');
  await media.assertInventory(manifest.blobs);
  if (saved.restoration === undefined) {
    for (const name of backupCollections) {
      if (name !== 'installation' && await db.collection(name).findOne({}, { projection: { _id: 1 } })) {
        throw new BackupError('Refusing to adopt a destination with existing Planner data.');
      }
    }
    if (Object.keys(saved).length !== 2) throw new BackupError('The destination already has installation metadata.');
    const { restoration: _prior, ...installation } = source;
    const result = await collection.replaceOne({ ...key, restoration: { $exists: false }, setup: { $exists: false },
      activeGenerationId: { $exists: false } }, { ...installation, _id: 'installation', schemaVersion: 0, activeGenerationId: null, restoration: marker }, durable);
    if (result.matchedCount !== 1) throw new BackupError('The Planner restore intent changed.');
  } else if (saved.activeGenerationId !== null || saved.restoration.fingerprint !== fingerprint
      || saved.restoration.generationId !== marker.generationId || saved.restoration.installationDigest !== marker.installationDigest
      || !['staging', 'staged'].includes(saved.restoration.phase)) {
    throw new BackupError('Repeat restore with the pending verified Planner backup.');
  }
  await migrateStorageSchema(db, manifest.installationId);
  const storedSource = await collection.findOne<Buffer>(key, { raw: true });
  if (!storedSource || installationDigest(BSON.deserialize(storedSource, { promoteValues: false })) !== marker.installationDigest) {
    throw new BackupError('The staged installation metadata differs from the backup.');
  }

  for (const part of manifest.collections) {
    if (part.name === 'installation') continue;
    const target = db.collection<StoredDocument>(part.name);
    const input = await archive.collection(part);
    try {
      for await (const row of archiveRows(input, part)) {
        const retained = destinationRow(part.name, row.record);
        if (!retained) continue;
        const expected = Buffer.from(BSON.serialize(retained));
        const old = await target.findOne<Buffer>({ _id: row.id }, { raw: true });
        if (old) {
          if (!Buffer.isBuffer(old) || !old.equals(expected)) throw new BackupError('A staged Planner row conflicts with the backup.');
        } else {
          await target.insertOne(retained as StoredDocument, durable);
          await checkpoint?.('row', `${part.name}/${row.id}`);
        }
      }
    } finally { await input.close(); }
  }
  for (const entry of manifest.blobs) {
    const file = await archive.blob(entry);
    try { await media.writeBlob(file, entry); } finally { await file.close(); }
    await checkpoint?.('blob', entry.sha256);
  }
  const verified = { ...marker, phase: 'staged' as const, inventory, blobs: manifest.blobs };
  await verifyStaged(db, media, verified);
  const result = await collection.updateOne({ ...key, activeGenerationId: { $type: 'null' },
    'restoration.fingerprint': fingerprint, 'restoration.generationId': marker.generationId, 'restoration.phase': { $in: ['staging', 'staged'] } },
  { $set: { restoration: verified } }, durable);
  if (result.matchedCount !== 1) throw new BackupError('The Planner restore verification could not be published.');
  await checkpoint?.('staged', fingerprint);
  return { manifestSha256: fingerprint, installationId: manifest.installationId, generationId: marker.generationId, state: 'staged' } as const;
}

export async function activateRestore(db: Db, writer: WriterLease, media: RestoreMedia, installationId: string,
  fingerprint: string, expectedProof: string, verifyKey: (digest: string | undefined) => void, checkpoint?: Checkpoint) {
  writer.assertHeld();
  const installation = await verifyStorageSchema(db, installationId);
  const marker = (installation as typeof installation & { restoration?: Restoration }).restoration;
  if (!marker || marker.fingerprint !== fingerprint || verificationProof(marker) !== expectedProof || !['staged', 'active'].includes(marker.phase)) {
    throw new BackupError('A matching verified staged backup is required for activation.');
  }
  verifyKey(installation.mfaKeyDigest);
  if (marker.phase === 'active') {
    if (installation.activeGenerationId !== marker.generationId) throw new BackupError('The activated restore identity is inconsistent.');
  } else {
    if (installation.activeGenerationId !== null) throw new BackupError('Refusing to replace an active Planner installation.');
    const raw = await db.collection<StoredDocument>('installation').findOne<Buffer>({ _id: 'installation', installationId }, { raw: true });
    if (!raw || installationDigest(BSON.deserialize(raw, { promoteValues: false })) !== marker.installationDigest) {
      throw new BackupError('The staged installation metadata differs from the backup.');
    }
    await verifyStaged(db, media, marker);
    const result = await db.collection<StoredDocument>('installation').updateOne({ _id: 'installation', installationId,
      activeGenerationId: { $type: 'null' }, mfaKeyDigest: installation.mfaKeyDigest, 'restoration.fingerprint': fingerprint,
      'restoration.generationId': marker.generationId, 'restoration.phase': 'staged' },
    { $set: { activeGenerationId: marker.generationId, 'restoration.phase': 'active' } }, durable);
    if (result.matchedCount !== 1) throw new BackupError('The Planner restore activation could not be published.');
    await checkpoint?.('activated', fingerprint);
  }
  return { manifestSha256: fingerprint, installationId, generationId: marker.generationId, state: 'active' } as const;
}
