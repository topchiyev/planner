import type { Db } from 'mongodb';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import { verifyStorageSchema } from '../../storage/schema.js';
import type { PrivateMediaStore } from '../../storage/blobs/private-store.js';
import { assertMigrationJournalSafe } from '../migration/cutover.js';
import { CleanCommandRejection, type CommandGate } from '../command-gate/gate.js';
import { BackupError, backupCollections, fileChunks, publishBackup, sha256, type Owner } from './archive.js';
import { bsonRecord, mediaInventory, rawRows, recordIdentity } from './records.js';

export async function createBackup(
  gate: CommandGate, db: Db, config: NativeInstallationConfig, key: Buffer,
  store: PrivateMediaStore, root: string, owner: Owner,
) {
  let unpin: (() => void) | undefined;
  try {
    return await publishBackup(root, owner, async (writer) => {
      const frozen = await gate.runCommand(async () => {
        try {
          const installation = await verifyStorageSchema(db, config.installationId);
          if (!installation.activeGenerationId || installation.setup?.pendingAction !== 'complete'
            || installation.setup.mode !== config.mode || key.length !== 32 || installation.mfaKeyDigest !== sha256(key)) {
            throw new BackupError('Only a verified, ready Planner installation can be backed up.');
          }
          await assertMigrationJournalSafe(db, installation, installation.activeGenerationId);
          const lists = await db.listCollections({}, { nameOnly: true }).toArray();
          if (lists.length !== backupCollections.length || lists.some(({ name }) => !backupCollections.includes(name))) {
            throw new BackupError('The Planner database contains an unrecognized collection.');
          }
          const inventory = await mediaInventory(db, installation.activeGenerationId);
          unpin = store.pin(inventory);
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
          const bytes = Buffer.from(JSON.stringify({ version: 1, config, mfaKey: key.toString('hex') }) + '\n');
          let secrets;
          try { secrets = await writer.secrets(bytes); } finally { bytes.fill(0); }
          return { installationId: config.installationId, activeGenerationId: installation.activeGenerationId,
            schemaVersion: installation.schemaVersion, createdAt: new Date().toISOString(), collections, inventory, secrets };
        } catch (error) {
          // Capture touches only a private archive. An output failure does not invalidate workspace readers.
          throw new CleanCommandRejection(error instanceof BackupError ? error.message : 'The Planner backup snapshot could not be captured.');
        }
      });
      const { inventory, ...snapshot } = frozen;
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
      return { ...snapshot, blobs };
    });
  } finally { unpin?.(); }
}
