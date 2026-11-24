import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MongoClient } from 'mongodb';
import { CleanCommandRejection, CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { installationId, journalOperations, request } from './journal-operations.mjs';

const [{ fixture, ownerDirectory, checkpoint, index }] = await once(process, 'message');
const uid = process.getuid();
const gid = process.getgid();
assert.match(fixture.directory, /^\/tmp\/planner-mongo-[a-zA-Z0-9]+$/u);
assert.equal(await realpath(fixture.directory), fixture.directory);
assert.equal(fixture.socketPath, join(fixture.directory, 'mongod.sock'));
const info = await lstat(fixture.socketPath);
assert.ok(info.isSocket() && info.uid === uid);
assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0);
const args = (await readFile(`/proc/${fixture.pid}/cmdline`, 'utf8')).split('\0');
assert.equal(basename(args[0]), 'mongod');
assert.ok(args.includes(join(fixture.directory, 'db')) && args.includes(fixture.socketPath));
const client = new MongoClient(`mongodb://${encodeURIComponent(fixture.socketPath)}/planner_fixture?directConnection=true`, {
  auth: fixture.auth, authSource: 'planner_fixture', serverSelectionTimeoutMS: 3000,
});
const gate = new CommandGate(acquireWriterDirectory(ownerDirectory, { uid, gid }, { uid, gid }));
try {
  const journal = new CommandJournal(gate, client.db('planner_fixture'), installationId, {
    operations: journalOperations(CleanCommandRejection),
    async checkpoint(point, at) {
      if (point !== checkpoint || (index !== undefined && at !== index)) return;
      process.channel.ref();
      process.send({ reached: point, at });
      await new Promise(() => {}); // The parent terminates this process at the acknowledged boundary.
    },
  });
  await journal.recover();
  await journal.execute(request);
  await journal.deliverPending((signal) => { process.send({ published: signal }); });
  throw new Error('The requested crash checkpoint was never reached.');
} finally {
  await gate.closeAndDrain();
  await client.close();
}
