import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { inspectBackup, stageRestore, activateRestore } from '../../apps/backend/dist/application/backup/restore.js';
import { openRestoreMedia } from '../../apps/backend/dist/application/backup/restore-media.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';

const input = await new Promise((resolve) => process.once('message', resolve));
const owner = { uid: process.getuid(), gid: process.getgid() };
const client = new MongoClient(`mongodb://${encodeURIComponent(input.socketPath)}/${input.database}?directConnection=true`, {
  auth: input.auth, authSource: input.database,
});
const db = client.db(input.database);
const lease = acquireWriterDirectory(input.target.writer, owner, owner);
const media = await openRestoreMedia({ ...input.target, owner, fingerprint: input.fingerprint });
let backup;
try {
  backup = await inspectBackup(input.archive, owner, input.fingerprint);
  async function checkpoint(point, id) {
    if (point !== input.point) return;
    await new Promise((resolve) => process.send({ point, id }, resolve));
    // The parent terminates this process once the acknowledged durable checkpoint is reported.
    await new Promise(() => {});
  }
  if (input.point === 'activated') {
    await activateRestore(db, lease, media, backup.config.installationId, input.fingerprint, backup.proof, (expected) => {
      if (createHash('sha256').update(backup.key).digest('hex') !== expected) throw new Error('Unmatched test key');
    }, checkpoint);
  } else {
    await stageRestore(db, lease, media, backup, checkpoint);
  }
} finally { await backup?.close(); await media.close(); lease.release(); await client.close(); }
