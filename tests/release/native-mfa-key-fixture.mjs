import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [action] = process.argv.slice(2);
const release = 'file:///opt/planner/current/apps/backend/dist/';
const load = (file) => import(new URL(file, release));
const { createNativeCommandGate } = await load('native/writer.js');
const { connectVerifiedNativeMongo } = await load('native/mongo-readiness.js');
const { CommandJournal } = await load('application/command-journal/journal.js');
const { readInstallation } = await load('storage/schema.js');
const credential = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const client = await connectVerifiedNativeMongo(credential);
const projectId = 'c0bfca06-a4df-4316-9194-584ae6c91988';
const operationId = 'fixture.mfa-key-binding';
try {
  const { installationId } = credential;
  const db = client.db('planner');
  const { activeGenerationId: generationId } = await readInstallation(db, installationId);
  assert.ok(generationId);
  const projects = db.collection('projects');
  const commands = db.collection('commands');
  const audit = db.collection('auditEntries');
  if (action === 'prepare') {
    const gate = createNativeCommandGate();
    try {
      const marker = new Error('Stop before prepared fixture execution.');
      const actor = await db.collection('users').findOne({ generationId, role: 'admin', disabledAt: null });
      assert.ok(actor);
      const journal = new CommandJournal(gate, db, installationId, {
        operations: {
          [operationId]: {
            normalize: () => ({}), authorize: () => {},
            plan: () => ({
              effects: [{ kind: 'insert', collection: 'projects', id: projectId, fields: { name: 'Pending test project' } }],
              audit: { resourceId: projectId, resourceType: 'project', action: operationId },
              result: { id: projectId },
            }),
          },
        },
        checkpoint: (step) => { if (step === 'prepared') throw marker; },
      });
      await journal.recover();
      await assert.rejects(() => journal.execute({ actorId: actor.id, operationId, idempotencyKey: randomUUID(), input: {} }), marker);
    } finally { await gate.closeAndDrain(); }
  } else {
    assert.ok(action === 'unapplied' || action === 'committed');
    const committed = action === 'committed';
    const command = await commands.findOne({ generationId, operationId });
    assert.equal(command.status, committed ? 'committed' : 'prepared');
    assert.equal(await projects.countDocuments({ generationId, id: projectId }), Number(committed));
    assert.equal(await audit.countDocuments({ generationId, commandId: command.id }), Number(committed));
  }
} finally { await client.close(); }
