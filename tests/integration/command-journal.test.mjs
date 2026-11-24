import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BSON, Long } from 'mongodb';
import { CleanCommandRejection, CommandGate, GateUnavailableError } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { createWorkspaceAccess } from '../../apps/backend/dist/application/command-gate/workspace-access.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { canonicalJournalData, commandUuid } from '../../apps/backend/dist/application/command-journal/operation.js';
import { maximumBatchBytes, packBatches } from '../../apps/backend/dist/application/command-journal/records.js';
import { keepCommandRecovery } from '../../apps/backend/dist/native/command-recovery.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { openActiveWorkspace, openTrustedStagedWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import {
  actorId, boardId, generationId, installationId, journalOperations, leftId, memberId, request, rightId, stagedGenerationId,
} from '../support/journal-operations.mjs';

assertOwnedMongoEnvironment(process.env);
const owner = { uid: process.getuid(), gid: process.getgid() };
const byGeneration = { generationId };
const operations = journalOperations(CleanCommandRejection);

async function seed(fixture, enrollment = false) {
  const { db, directory } = fixture;
  const ownerDirectory = join(directory, 'writer');
  await mkdir(ownerDirectory, { mode: 0o750 });
  await chmod(ownerDirectory, 0o750);
  await db.collection('installation').insertOne({
    _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: enrollment ? null : generationId,
    setup: { mode: 'fresh', pendingAction: 'first-admin-enrollment',
      enrollmentGenerationId: enrollment ? generationId : stagedGenerationId },
  });
  await migrateStorageSchema(db, installationId);
  const workspace = enrollment ? await openTrustedStagedWorkspace(db, installationId, generationId)
    : await openActiveWorkspace(db, installationId);
  await workspace.insert('users', actorId, { normalizedEmail: 'fixture@example.test', disabled: false });
  await workspace.insert('projects', leftId, { balance: 10 });
  await workspace.insert('projects', rightId, { balance: 0 });
  await workspace.insert('boardMembers', memberId, { boardId, userId: actorId });
  return ownerDirectory;
}

function open(db, ownerDirectory, options) {
  const gate = new CommandGate(acquireWriterDirectory(ownerDirectory, owner, owner));
  const journal = new CommandJournal(gate, db, installationId, { operations, ...options });
  return { gate, journal };
}

async function killAt(fixture, ownerDirectory, checkpoint, index) {
  const child = fork(fileURLToPath(new URL('../support/journal-process.mjs', import.meta.url)), [],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  const delivered = [];
  const reached = new Promise((resolve) => child.on('message', (message) => {
    if (message.published) delivered.push(message.published);
    if (message.reached === checkpoint) resolve(message);
  }));
  const { username, password } = fixture.client.options.credentials;
  child.send({ fixture: { directory: fixture.directory, socketPath: fixture.socketPath, pid: fixture.pid,
    auth: { username, password } }, ownerDirectory, checkpoint, index });
  const limit = AbortSignal.timeout(35_000);
  try {
    const outcome = await Promise.race([reached, exited.then(([code, signal]) => ({ code, signal })),
      once(limit, 'abort').then(() => ({ timedOut: true }))]);
    assert.equal(outcome.reached, checkpoint, stderr || JSON.stringify(outcome));
    if (index !== undefined) assert.equal(outcome.at, index);
  } finally { child.kill('SIGKILL'); await exited; }
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  return delivered;
}

async function rawBalance(db, id) {
  return (await db.collection('projects').findOne({ ...byGeneration, id })).balance;
}

async function assertApplied(db) {
  assert.equal(await rawBalance(db, leftId), 7);
  assert.equal(await rawBalance(db, rightId), 3);
  assert.equal(await db.collection('boardMembers').countDocuments({ ...byGeneration, id: memberId }), 0);
  assert.equal(await db.collection('auditEntries').countDocuments(byGeneration), 1);
  const events = await db.collection('events').find(byGeneration, { promoteLongs: false }).sort({ sequence: 1 }).toArray();
  assert.deepEqual(events.map(({ sequence }) => sequence.toString()), ['1', '2']);
  assert.equal(new Set(events.map(({ id }) => id)).size, 2);
}

for (const [phase, index] of [['beforeIntent'], ['batchStored', 0], ['prepared'], ['effectApplied', 0],
  ['deleteReserved', 2], ['effectApplied', 2], ['committed'], ['beforeDelivery'], ['afterDelivery']]) {
  test(`restarts after killing the isolated writer at ${phase}${index === undefined ? '' : `/${index}`}`, { timeout: 55_000 }, async () => {
    await withFixtureMongo(async (fixture) => {
      const ownerDirectory = await seed(fixture);
      const { db } = fixture;
      const previouslyPublished = await killAt(fixture, ownerDirectory, phase, index);
      const command = await db.collection('commands').findOne(byGeneration);
      if (phase === 'beforeIntent') assert.equal(command, null);
      if (phase === 'batchStored') {
        assert.equal(command.status, 'building');
        assert.equal(await db.collection('commandEffectBatches').countDocuments(byGeneration), 1);
      }
      if (['beforeIntent', 'batchStored', 'prepared'].includes(phase)) {
        assert.equal(await rawBalance(db, leftId), 10);
        assert.equal(await rawBalance(db, rightId), 0);
        assert.equal(await db.collection('auditEntries').countDocuments(byGeneration), 0);
      }
      if (phase === 'effectApplied' && index === 0) {
        assert.equal(await rawBalance(db, leftId), 7);
        assert.equal(await rawBalance(db, rightId), 0);
        assert.equal(command.applied, 0);
      }
      if (index === 2) {
        assert.equal(command.applied, 2);
        assert.ok(command.pendingDelete);
        assert.equal(await db.collection('boardMembers').countDocuments(byGeneration), phase === 'deleteReserved' ? 1 : 0);
      }
      if (['committed', 'beforeDelivery', 'afterDelivery'].includes(phase)) {
        assert.equal(command.status, 'committed');
        assert.equal(command.delivered, 0);
        assert.equal(command.outboxPending, true);
        await assertApplied(db);
      }
      if (phase === 'afterDelivery') assert.equal(previouslyPublished.length, 1);
      else assert.equal(previouslyPublished.length, 0);

      const { gate, journal } = open(db, ownerDirectory);
      try {
        await assert.rejects(gate.readSnapshot(() => 'unavailable'), GateUnavailableError);
        await journal.recover();
        const result = await journal.execute(request);
        assert.equal(result.balance, 3);
        assert.match(result.labelId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
        const [label, duplicate] = await db.collection('labels').find(byGeneration).toArray();
        assert.ok(!duplicate);
        assert.equal(label.id, result.labelId);
        if (command?.result) assert.equal(result.labelId, JSON.parse(command.result).labelId);
        if (command) {
          assert.equal(result.commandId, command.id);
          assert.equal(result.receivedAt, command.createdAt.toISOString());
        }
        assert.deepEqual(await journal.execute({ ...request, input: { rightRevision: 1, amount: 3, leftRevision: 1 } }), result);
        await assertApplied(db);

        const published = [];
        await journal.deliverPending((signal) => { published.push(signal); });
        await journal.deliverPending(() => assert.fail('an acknowledged event was published again'));
        assert.deepEqual(published.map(({ sequence }) => sequence), ['1', '2']);
        if (previouslyPublished.length) assert.deepEqual(previouslyPublished[0], published[0]);
        const acknowledged = await db.collection('commands').findOne(byGeneration);
        assert.equal(acknowledged.delivered, 2);
        assert.equal(acknowledged.outboxPending, false);
      } finally { await gate.closeAndDrain(); }
    });
  });
}

test('a rebuilt intent publishes after commands that prepared first', { timeout: 55_000 }, async () => {
  await withFixtureMongo(async (fixture) => {
    const { db } = fixture;
    const ownerDirectory = await seed(fixture);
    await killAt(fixture, ownerDirectory, 'batchStored', 0);
    const building = await db.collection('commands').findOne(byGeneration);
    assert.equal(building.status, 'building');
    assert.equal(building.recoverySequence, undefined);
    const emit = {
      ...operations['projects.transfer'],
      plan() {
        return { effects: [], result: null,
          audit: { resourceId: leftId, resourceType: 'project', action: 'projects.announce' },
          events: [{ boardId, kind: 'board.announced', payload: null }] };
      },
    };
    const { gate, journal } = open(db, ownerDirectory, { operations: { ...operations, 'projects.announce': emit } });
    try {
      await journal.recover();
      await journal.execute({ ...request, operationId: 'projects.announce' });
      await journal.execute(request);
      const signals = [];
      await journal.deliverPending((signal) => { signals.push(signal); });
      assert.deepEqual(signals.map(({ boardId, sequence }) => [boardId, sequence]),
        [[boardId, '1'], [boardId, '2'], [boardId, '3']]);
      assert.equal((await db.collection('commands').findOne({ _id: building._id })).recoverySequence, 2);
    } finally { await gate.closeAndDrain(); }
  });
});

test('a live recovery worker replays transient failure under the retained writer lease', { timeout: 55_000 }, async () => {
  await withFixtureMongo(async (fixture) => {
    const { db } = fixture;
    const ownerDirectory = await seed(fixture);
    const { gate, journal } = open(db, ownerDirectory, {
      checkpoint(phase, step) {
        if (phase === 'effectApplied' && step === 0) throw new Error('Temporary interruption after the first write.');
      },
    });
    let unblock;
    let attempts = 0;
    const held = new Promise((resolve) => { unblock = resolve; });
    const recovery = new CommandJournal(gate, db, installationId);
    const stop = keepCommandRecovery(gate, async (running) => {
      attempts += 1;
      if (attempts === 2) await held;
      if (running()) await recovery.recover();
    });
    async function waitForOpen() {
      const deadline = Date.now() + 8_000;
      while (!gate.ready && Date.now() < deadline) await delay(25);
      assert.equal(gate.ready, true);
    }
    try {
      await waitForOpen();
      await assert.rejects(journal.execute(request), /Temporary interruption/u);
      assert.equal(gate.state, 'maintenance');
      await assert.rejects(gate.readSnapshot(() => 'blocked'), GateUnavailableError);
      assert.equal(await rawBalance(db, leftId), 7);
      assert.equal(await rawBalance(db, rightId), 0);
      unblock();
      await waitForOpen();
      await assertApplied(db);
      assert.equal(await db.collection('commands').countDocuments(byGeneration), 1);
    } finally { unblock(); stop(); await gate.closeAndDrain(); }
  });
});

test('a concurrent reader never sees half of a transfer, and replay checks current access first', { timeout: 40_000 }, async () => {
  await withFixtureMongo(async (fixture) => {
    const ownerDirectory = await seed(fixture);
    const { db } = fixture;
    let reach;
    let resume;
    const first = new Promise((resolve) => { reach = resolve; });
    const release = new Promise((resolve) => { resume = resolve; });
    const { gate, journal } = open(db, ownerDirectory, { async checkpoint(phase, index) {
      if (phase === 'effectApplied' && index === 0) {
        reach();
        await release;
      }
    } });
    try {
      await journal.recover();
      const access = createWorkspaceAccess(gate, db, installationId);
      const command = journal.execute(request);
      await first;
      let completed = false;
      const reader = access.readSnapshot(async (workspace) => {
        completed = true;
        const [left, right] = await Promise.all([workspace.read('projects', leftId), workspace.read('projects', rightId)]);
        return [left.balance, right.balance];
      });
      await delay(50);
      assert.equal(completed, false);
      resume();
      const result = await command;
      assert.deepEqual(await reader, [7, 3]);
      await assert.rejects(journal.execute({ ...request, input: { ...request.input, leftRevision: 2 } }),
        { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
      await gate.runCommand(() => db.collection('users').updateOne({ ...byGeneration, id: actorId }, { $set: { disabled: true } }));
      await assert.rejects(journal.execute({ ...request, input: { ...request.input, leftRevision: 2 } }), /Access denied/u);
      await gate.runCommand(() => db.collection('users').updateOne({ ...byGeneration, id: actorId }, { $set: { disabled: false } }));
      await gate.runCommand(() => db.collection('projects').updateOne({ ...byGeneration, id: leftId }, { $set: { hiddenFromActor: true } }));
      await assert.rejects(journal.execute(request), /Access denied/u);
      await gate.runCommand(() => db.collection('projects').updateOne({ ...byGeneration, id: leftId }, { $set: { hiddenFromActor: false } }));
      assert.deepEqual(await journal.execute(request), result);
      await assertApplied(db);
      assert.equal(gate.ready, true);
    } finally { resume(); await gate.closeAndDrain(); }
  });
});

for (const fault of ['batch digest', 'prepared event count', 'advanced applied cursor', 'wrong applied effect', 'missing deletion target', 'missing outbox event',
  'false outbox marker', 'missing outbox marker', 'advanced delivery cursor', 'wrong delivered event']) {
  test(`recovery closes the gate for a ${fault}`, { timeout: 45_000 }, async () => {
    await withFixtureMongo(async (fixture) => {
      const ownerDirectory = await seed(fixture);
      const { db } = fixture;
      const prepared = ['batch digest', 'prepared event count', 'advanced applied cursor',
        'wrong applied effect', 'missing deletion target'].includes(fault);
      await killAt(fixture, ownerDirectory, prepared ? 'prepared' : 'committed');
      if (fault === 'batch digest') {
        await db.collection('commandEffectBatches').updateOne(byGeneration, { $set: { payload: '[]' } });
      } else if (fault === 'prepared event count') {
        await db.collection('commands').updateOne(byGeneration, { $set: { eventCount: 0, delivered: 0, outboxPending: false } });
      } else if (fault === 'advanced applied cursor' || fault === 'wrong applied effect') {
        await db.collection('commands').updateOne(byGeneration, { $set: { applied: 1,
          ...(fault === 'wrong applied effect' && { lastAppliedEffectId: actorId }) } });
      } else if (fault === 'missing deletion target') {
        await db.collection('boardMembers').deleteOne(byGeneration);
      } else if (fault === 'missing outbox event') {
        await db.collection('events').deleteOne(byGeneration);
      } else if (fault === 'advanced delivery cursor' || fault === 'wrong delivered event') {
        await db.collection('commands').updateOne(byGeneration, { $set: { delivered: 1,
          ...(fault === 'wrong delivered event' && { lastDeliveredEventId: actorId }) } });
      } else {
        await db.collection('commands').updateOne(byGeneration, fault === 'false outbox marker'
          ? { $set: { outboxPending: false } } : { $unset: { outboxPending: '' } });
      }
      const { gate, journal } = open(db, ownerDirectory);
      try {
        await assert.rejects(journal.recover());
        assert.equal(gate.state, 'maintenance');
        assert.equal(gate.ready, false);
        await assert.rejects(gate.readSnapshot(() => 'unavailable'), GateUnavailableError);
        if (prepared) {
          assert.equal((await db.collection('commands').findOne(byGeneration)).status, 'prepared');
          assert.equal(await db.collection('auditEntries').countDocuments(byGeneration), 0);
        }
        if (['prepared event count', 'advanced applied cursor', 'wrong applied effect'].includes(fault)) {
          assert.equal(await rawBalance(db, leftId), 10);
          assert.equal(await db.collection('events').countDocuments(byGeneration), 0);
        }
      } finally { await gate.closeAndDrain(); }
    });
  });
}

for (const transition of ['cutover', 'maintenance']) {
  test(`an outbox selection loses publication authority on ${transition} before handoff`, { timeout: 40_000 }, async () => {
    await withFixtureMongo(async (fixture) => {
      const ownerDirectory = await seed(fixture);
      const { db } = fixture;
      let select;
      let resume;
      const selected = new Promise((resolve) => { select = resolve; });
      const release = new Promise((resolve) => { resume = resolve; });
      const { gate, journal } = open(db, ownerDirectory, { async checkpoint(phase) {
        if (phase === 'beforeDelivery') {
          select();
          await release;
        }
      } });
      try {
        await journal.recover();
        await journal.execute(request);
        const drain = journal.deliverPending(() => assert.fail('an obsolete signal was handed off'));
        await selected;
        if (transition === 'cutover') {
          await gate.runCommand(() => db.collection('installation').updateOne(
            { _id: 'installation' }, { $set: { activeGenerationId: stagedGenerationId } },
          ));
          resume();
          await drain;
        } else {
          await assert.rejects(gate.runCommand(() => { throw new Error('an uncertain command'); }), /uncertain/u);
          resume();
          await assert.rejects(drain, GateUnavailableError);
        }
        assert.equal((await db.collection('commands').findOne(byGeneration)).delivered, 0);
      } finally { resume(); await gate.closeAndDrain(); }
    });
  });
}

test('a cutover retains pending delivery in the old generation, and active keys stay generation-local', { timeout: 40_000 }, async () => {
  await withFixtureMongo(async (fixture) => {
    const ownerDirectory = await seed(fixture);
    const { db } = fixture;
    const stage = await openTrustedStagedWorkspace(db, installationId, stagedGenerationId);
    await stage.insert('users', actorId, { normalizedEmail: 'fixture@example.test', disabled: false });
    await stage.insert('projects', leftId, { balance: 10 });
    await stage.insert('projects', rightId, { balance: 0 });
    await stage.insert('boardMembers', memberId, { boardId, userId: actorId });
    const { gate, journal } = open(db, ownerDirectory);
    const activate = (id) => gate.runCommand(() => db.collection('installation')
      .updateOne({ _id: 'installation' }, { $set: { activeGenerationId: id } }));
    try {
      await journal.recover();
      const old = await journal.execute(request);
      const delivered = [];
      await journal.deliverPending(async (signal) => {
        delivered.push(signal);
        await activate(stagedGenerationId);
      });
      assert.equal(delivered.length, 1);
      assert.equal((await db.collection('commands').findOne(byGeneration)).delivered, 0);
      const current = await journal.execute(request);
      assert.notEqual(current.commandId, old.commandId);
      assert.equal((await db.collection('commands').findOne({ generationId: stagedGenerationId })).recoverySequence, 1);
      await activate(generationId);
      const replay = [];
      await journal.deliverPending((signal) => { replay.push(signal); });
      assert.deepEqual(replay[0], delivered[0]);
      assert.equal(replay.length, 2);
    } finally { await gate.closeAndDrain(); }
  });
});

test('a command can bind only the explicit enrollment generation while activation is pending', { timeout: 35_000 }, async () => {
  await withFixtureMongo(async (fixture) => {
    const ownerDirectory = await seed(fixture, true);
    const { db } = fixture;
    const { gate, journal } = open(db, ownerDirectory, { scope: 'enrollment' });
    try {
      await journal.recover();
      const result = await journal.execute({ ...request, operationId: 'enrollment.fixture', generationId: stagedGenerationId });
      assert.equal(result.balance, 3);
      assert.equal(await db.collection('commands').countDocuments(byGeneration), 1);
      assert.equal(await db.collection('commands').countDocuments({ generationId: stagedGenerationId }), 0);
      assert.equal(await db.collection('events').countDocuments(byGeneration), 0);
    } finally { await gate.closeAndDrain(); }
  });
});

test('batch bounds account for BSON bytes and journal data rejects sensitive fields', () => {
  const id = commandUuid(generationId, ['fixture-batches']);
  const command = { _id: workspaceKey(generationId, id), id, generationId, recoverySequence: Long.ONE };
  const effect = (n, fields) => ({ kind: 'insert', collection: 'labels', id: commandUuid(id, [String(n)]), fields });
  const count = packBatches(command, Array.from({ length: 300 }, (_, n) => effect(n, { name: 'fixture' })));
  assert.deepEqual(count.manifest.map(({ count }) => count), [256, 44]);
  const text = 'µ'.repeat(600_000);
  const byteBound = packBatches(command, [effect(0, { name: text }), effect(1, { name: text })]);
  assert.deepEqual(byteBound.manifest.map(({ count }) => count), [1, 1]);
  for (const batch of byteBound.records) assert.ok(BSON.calculateObjectSize(batch) <= maximumBatchBytes);
  assert.throws(() => packBatches(command, [effect(0, { name: text.repeat(2) })]), /batch size/u);
  assert.throws(() => canonicalJournalData({ nested: [{ passwordHash: 'secret' }] }), /prohibited/u);
  assert.throws(() => packBatches(command, [effect(0, { refresh_token: 'secret' })]), /prohibited/u);
});
