import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { createMediaDecoder } from '../../apps/backend/dist/application/media/decoder.js';
import { activateVerifiedMigration } from '../../apps/backend/dist/application/migration/activation.js';
import { readProtectedMigrationRun, stageProtectedMigrationRun } from '../../apps/backend/dist/native/migration-state.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';

const input = await new Promise((resolve) => process.once('message', resolve));
const owner = { uid: process.getuid(), gid: process.getgid() };
const client = new MongoClient(`mongodb://${encodeURIComponent(input.socketPath)}/${input.database}?directConnection=true`, {
  auth: input.auth, authSource: input.database,
});
const db = client.db(input.database);
const lease = acquireWriterDirectory(input.writer, owner, owner);
const directory = await open(input.receipts);
async function checkpoint() {
  await new Promise((resolve) => process.send(input.point, resolve));
  await new Promise(() => {});
}
try {
  const saved = await readProtectedMigrationRun(db, input.installationId, directory, owner, input.runId);
  if (input.point === 'activation') {
    await activateVerifiedMigration(db, lease, input.installationId, saved.cursors, input.activation, checkpoint);
  } else {
    const driver = new Proxy(db, { get(target, property) {
      if (property !== 'collection') return Reflect.get(target, property, target);
      return (name, ...options) => {
        const rows = target.collection(name, ...options);
        if (name !== 'importIds') return rows;
        return new Proxy(rows, { get(collection, key) {
          if (key === 'insertOne') return async (...args) => { await collection.insertOne(...args); await checkpoint(); };
          const value = Reflect.get(collection, key, collection);
          return typeof value === 'function' ? value.bind(collection) : value;
        } });
      };
    } });
    const store = await createPrivateMediaStore(input.staging, input.blobs);
    try {
      const decode = createMediaDecoder(fileURLToPath(new URL('../../ops/package/decode-media.py', import.meta.url)),
        process.env.PLANNER_TEST_MEDIA_PYTHON ?? undefined);
      await stageProtectedMigrationRun(driver, lease, saved, owner, input.source, undefined, { store, decode }, 1);
    } finally { await store.close(); }
  }
} finally { await directory.close(); lease.release(); await client.close(); }
