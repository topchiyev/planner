import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { actorId, boardId, journalOperations, leftId, memberId, request, rightId } from './journal-operations.mjs';

const [, , work, action] = process.argv;
const release = '/opt/planner/current';
const backend = (path) => import(pathToFileURL(release + '/apps/backend/dist/' + path));
const { BSON } = await import(pathToFileURL(release + '/node_modules/mongodb/lib/index.js'));
const { parseMongoCredentials, databaseName } = await backend('native/mongo-identity.js');
const { connectVerifiedNativeMongo, mongoCredentialFile } = await backend('native/mongo-readiness.js');
const { readInstallation } = await backend('storage/schema.js');
const credentials = parseMongoCredentials(JSON.parse(await readFile(mongoCredentialFile, 'utf8')));
const client = await connectVerifiedNativeMongo(credentials);
const db = client.db(databaseName);
const durable = { writeConcern: { w: 1, j: true } };
const installation = db.collection('installation');
const { installationId } = credentials;

try {
  const state = await readInstallation(db, installationId);
  const identity = { _id: state._id, installationId };
  const generationId = state.setup.enrollmentGenerationId;
  assert.equal(state.setup.mode, 'fresh');
  assert.equal(state.setup.pendingAction, 'first-admin-enrollment');
  const scope = { generationId };

  const balances = async () => Promise.all([leftId, rightId].map(async (id) =>
    (await db.collection('projects').findOne({ ...scope, id })).balance));
  const command = () => db.collection('commands').findOne(scope);
  const events = db.collection('events');

  if (action === 'interrupt') {
    assert.equal(state.activeGenerationId, null);
    const { openActiveWorkspace } = await backend('storage/scoped.js');
    const { createNativeCommandGate } = await backend('native/writer.js');
    const { CleanCommandRejection } = await backend('application/command-gate/gate.js');
    const { CommandJournal } = await backend('application/command-journal/journal.js');
    const gate = createNativeCommandGate();
    try {
      assert.equal((await installation.updateOne({ ...identity, activeGenerationId: { $type: 'null' } },
        { $set: { activeGenerationId: generationId } }, durable)).matchedCount, 1);
      const workspace = await openActiveWorkspace(db, installationId);
      await workspace.insert('users', actorId, { normalizedEmail: 'fixture@example.test', disabled: false });
      await workspace.insert('projects', leftId, { balance: 10 });
      await workspace.insert('projects', rightId, { balance: 0 });
      await workspace.insert('boardMembers', memberId, { boardId, userId: actorId });
      const journal = new CommandJournal(gate, db, installationId, {
        operations: journalOperations(CleanCommandRejection),
        async checkpoint(phase, step) {
          if (phase === 'effectApplied' && step === 0) process.kill(process.pid, 'SIGKILL');
        },
      });
      await journal.recover();
      await journal.execute(request);
      assert.fail('The fixture did not stop at the acknowledged first write.');
    } finally { await gate.closeAndDrain(); }
  } else if (action === 'verify-interrupted') {
    assert.equal(state.activeGenerationId, generationId);
    assert.deepEqual(await balances(), [7, 0]);
    const stored = await command();
    assert.equal(stored.status, 'prepared');
    assert.equal(stored.applied, 0);
    assert.equal(await db.collection('auditEntries').countDocuments(scope), 0);
  } else if (action === 'verify-recovered') {
    assert.deepEqual(await balances(), [7, 3]);
    const stored = await command();
    assert.equal(stored.status, 'committed');
    assert.equal(stored.delivered, 0);
    assert.equal(stored.outboxPending, true);
    assert.equal(await db.collection('boardMembers').countDocuments(scope), 0);
    assert.equal(await db.collection('auditEntries').countDocuments(scope), 1);
    const label = await db.collection('labels').findOne(scope);
    assert.equal(label.id, JSON.parse(stored.result).labelId);
    assert.equal(await db.collection('labels').countDocuments(scope), 1);
    assert.deepEqual((await events.find(scope, { promoteLongs: false }).sort({ sequence: 1 }).toArray())
      .map(({ sequence, commandId }) => [sequence.toString(), commandId]), [['1', stored.id], ['2', stored.id]]);
  } else if (action === 'remove-outbox-event') {
    assert.equal((await installation.updateOne({ ...identity, activeGenerationId: generationId },
      { $set: { activeGenerationId: null } }, durable)).matchedCount, 1);
    const event = await events.findOne({ ...scope, ordinal: 0 }, { promoteLongs: false });
    assert.ok(event);
    await writeFile(work + '/saved-event.json', BSON.EJSON.stringify(event, { relaxed: false }), { mode: 0o600, flag: 'wx' });
    assert.equal((await events.deleteOne({ ...scope, _id: event._id }, durable)).deletedCount, 1);
  } else if (action === 'restore-outbox-event') {
    assert.equal(state.activeGenerationId, null);
    const event = BSON.EJSON.parse(await readFile(work + '/saved-event.json', 'utf8'), { relaxed: false });
    assert.equal(event.generationId, generationId);
    await events.insertOne(event, durable);
  } else {
    assert.fail('Unknown fixture action.');
  }
} finally { await client.close(); }
