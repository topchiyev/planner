import type { Db } from 'mongodb';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import { verifyStorageSchema } from '../../storage/schema.js';
import type { PrivateMediaStore } from '../../storage/blobs/private-store.js';
import { CleanCommandRejection, type CommandGate } from '../command-gate/gate.js';
import { BackupError, backupCollections, fileChunks, publishBackup, sha256, type Owner } from './archive.js';
import { bsonRecord, mediaInventory, rawRows, recordIdentity } from './records.js';

export function createBackup(
  gate: CommandGate, db: Db, config: NativeInstallationConfig, key: Buffer,
  store: PrivateMediaStore, root: string, owner: Owner,
) {
  return gate.runCommand(async () => {
    try {
      const installation = await verifyStorageSchema(db, config.installationId);
      if (!installation.activeGenerationId || installation.setup?.pendingAction !== 'complete'
        || installation.setup.mode !== config.mode || key.length !== 32 || installation.mfaKeyDigest !== sha256(key)) {
        throw new BackupError('Only a verified, ready Planner installation can be backed up.');
      }
      const lists = await db.listCollections({}, { nameOnly: true }).toArray();
      if (lists.length !== backupCollections.length || lists.some(({ name }) => !backupCollections.includes(name))) {
        throw new BackupError('The Planner database contains an unrecognized collection.');
      }
      const inventory = await mediaInventory(db, installation.activeGenerationId);
      const unpin = store.pin(inventory);
      try {
        return await publishBackup(root, owner, async (writer) => {
          const collections = [];
          for (const name of backupCollections) {
            let rows = 0;
            async function* captureRows() {
              for await (const bytes of rawRows(db, name)) {
                recordIdentity(name, bsonRecord(bytes));
                rows += 1;
                yield bytes;
              }
            }
            const captured = await writer.collection(name, captureRows());
            collections.push({ name, ...captured, rows });
          }
          const blobs = [];
          for (const identity of inventory) {
            const descriptor = await store.openBlob(identity);
            try {
              const captured = await writer.blob(identity.digest, fileChunks(descriptor, identity.byteLength));
              if (captured.sha256 !== identity.digest || captured.byteLength !== identity.byteLength) {
                throw new BackupError('A referenced Planner media file did not match its digest.');
              }
              blobs.push(captured);
            } finally { await descriptor.close(); }
          }
          const bytes = Buffer.from(JSON.stringify({ version: 1, config, mfaKey: key.toString('hex') }) + '\n');
          let secrets;
          try { secrets = await writer.secrets(bytes); } finally { bytes.fill(0); }
          return { installationId: config.installationId, activeGenerationId: installation.activeGenerationId!,
            schemaVersion: installation.schemaVersion, createdAt: new Date().toISOString(), collections, blobs, secrets };
        });
      } finally { unpin(); }
    } catch (error) {
      // Capture changes neither the workspace nor its auth state. Ordinary readers may continue after a failed private copy.
      throw new CleanCommandRejection(error instanceof BackupError ? error.message : 'The Planner backup could not be captured.');
    }
  });
}
