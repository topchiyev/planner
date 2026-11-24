import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { planTransferredCardFieldGroup } from '../../apps/backend/dist/application/workspace/field-copies.js';
import { createWorkspaceRecords } from '../../apps/backend/dist/application/workspace/records.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const path = (kind, id) => '/api/v1/' + kind + '/' + id;
const card = (id = ids.activeCard) => path('cards', id);
const board = (id = ids.privateBoard) => path('boards', id);
const project = (id = ids.privateProject) => path('projects', id);
const group = (id) => path('field-groups', id);
const field = (id) => path('fields', id);
const valuePath = (groupId, definitionId, cardId) => card(cardId) + '/field-values/' + groupId + '/' + definitionId;

async function workspace(run) {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    try { await run(f); } finally { await f.close(); }
  });
}

async function signIn(f, actor) {
  const loggedIn = await f.login(actor);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

function change(f, actor, method, route, revision, body, key = randomUUID()) {
  return f.call(route, actor, { method, body, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(actor)), 'If-Match': `"${revision}"`, 'Idempotency-Key': key,
  } });
}

async function expectResponse(pending, status, code) {
  const result = await pending;
  assert.equal(result.status, status, JSON.stringify(result.data).slice(0, 1000));
  assert.equal(result.headers['cache-control'], 'no-store');
  if (code) assert.equal(result.data.error.code, code);
  return result;
}

const data = async (pending, status = 200) => (await expectResponse(pending, status)).data.data;
const row = (f, name, id) => f.db.collection(name).findOne({ ...f.scope, id });
const textOf = (card, group, definition) => card.values.find(({ fieldGroupId, fieldDefinitionId }) =>
  fieldGroupId === group && fieldDefinitionId === definition)?.value;

async function seedLinked(f) {
  const template = await f.insert('fieldGroups', fixtureId(570), {
    scopeType: 'project', scopeId: ids.privateProject, name: 'Release template', rank: '1024',
  });
  const first = await f.insert('fieldGroups', fixtureId(571), {
    scopeType: 'board', scopeId: ids.privateBoard, templateGroupId: template, name: null, rank: '2048',
  });
  const second = await f.insert('fieldGroups', fixtureId(572), {
    scopeType: 'card', scopeId: ids.activeCard, templateGroupId: template, name: null, rank: '1024',
  });
  const def = await f.insert('fieldDefinitions', fixtureId(581), {
    fieldGroupId: template, name: 'Visible field', showOnFront: true, rank: '1024',
  });
  const hidden = await f.insert('fieldDefinitions', fixtureId(582), {
    fieldGroupId: template, name: 'Hidden field', showOnFront: false, rank: '2048',
  });
  const val = await f.insert('fieldValues', fixtureId(590), {
    cardId: ids.activeCard, fieldGroupId: first, fieldDefinitionId: def, value: '  blue / λ  ',
  });
  await f.insert('fieldValues', fixtureId(591), { cardId: ids.activeCard, fieldGroupId: second, fieldDefinitionId: def, value: '0' });
  await f.insert('fieldValues', fixtureId(592), { cardId: ids.activeCard, fieldGroupId: first, fieldDefinitionId: hidden, value: 'Only in inspector' });
  return { template, first, second, def, hidden, val };
}

test('custom field values resolve exact current tuples and retain independent inherited text and front visibility', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const { template, first, second, def, hidden, val } = await seedLinked(f);
    const editor = await signIn(f, ids.firstEditor);
    const manager = await signIn(f, ids.privateOwner);
    const viewer = await signIn(f, ids.viewer);
    const get = () => data(f.call(card(), editor));
    let current = await get();
    for (const id of [first, second]) {
      const instance = current.fields.find((item) => item.id === id);
      assert.deepEqual([instance.name, instance.localName, instance.linked], ['Release template', null, true]);
      assert.deepEqual(instance.definitions.map(({ id: definition, fieldGroupId, inherited }) =>
        [definition, fieldGroupId, inherited]), [[def, id, true], [hidden, id, true]]);
      assert.ok(!JSON.stringify(instance).includes(template));
    }
    assert.deepEqual([textOf(current, first, def), textOf(current, second, def)], ['  blue / λ  ', '0']);
    const fronts = await data(f.call(board() + '/cards', viewer));
    assert.deepEqual(fronts.find(({ id }) => id === ids.activeCard).frontFields.map(({ fieldGroupId, value }) =>
      [fieldGroupId, value]), [[first, '  blue / λ  '], [second, '0']]);
    const staged = await f.insert('fieldDefinitions', fixtureId(583), { fieldGroupId: first, name: 'Staged field', rank: '1024' }, f.stagedGenerationId);
    const other = await f.insert('fieldGroups', fixtureId(573), { scopeType: 'board', scopeId: ids.sharedBoard, name: 'Foreign group', rank: '1' });
    const revisions = { groupRevision: 1, definitionRevision: 1 };
    for (const [groupId, definitionId] of [[template, def], [first, staged], [other, def], [first, ids.fieldDefinition]]) {
      await expectResponse(change(f, editor, 'PUT', valuePath(groupId, definitionId), 1, { ...revisions, value: 'denied' }), 404);
      await expectResponse(change(f, editor, 'DELETE', valuePath(groupId, definitionId), 1, revisions), 404);
    }
    await expectResponse(change(f, viewer, 'PUT', valuePath(first, def), 1, { ...revisions, value: '' }), 403);
    await expectResponse(change(f, editor, 'PUT', valuePath(first, def, ids.archivedStory), 1, { ...revisions, value: '' }), 403);
    await expectResponse(change(f, manager, 'PATCH', field(def), 1, { groupId: first, name: 'No projected edit' }), 404);
    await expectResponse(change(f, editor, 'POST', project() + '/field-templates', 1, { name: 'Manager only' }), 403);
    await expectResponse(change(f, editor, 'POST', board() + '/field-groups', 1,
      { scopeType: 'card', name: 'Route override' }), 422);
    const options = await data(f.call(board() + '/field-template-options', editor));
    assert.deepEqual(options.map(({ id }) => id), [template]);
    await expectResponse(f.call(board() + '/field-template-options', viewer), 403);
    await expectResponse(change(f, editor, 'PUT', valuePath(first, def), 1, { ...revisions, groupRevision: 2, value: '' }), 409);
    await expectResponse(change(f, editor, 'PUT', valuePath(first, def), 1, { ...revisions, value: 'λ'.repeat(513) }), 422);
    const exact = '  \n' + '🧪'.repeat(508) + ' ';
    const key = randomUUID();
    const before = await row(f, 'fieldValues', val);
    const written = await data(change(f, editor, 'PUT', valuePath(first, def), 1, { ...revisions, value: exact }, key));
    assert.deepEqual(await data(change(f, editor, 'PUT', valuePath(first, def), 1, { ...revisions, value: exact }, key)), written);
    assert.deepEqual(written, { cardId: ids.activeCard, revision: 2 });
    const saved = await row(f, 'fieldValues', val);
    assert.equal(saved.value, exact);
    assert.deepEqual([saved.id, saved.createdAt], [before.id, before.createdAt]);
    assert.equal(textOf(await get(), second, def), '0');
    await data(change(f, editor, 'PUT', valuePath(first, def), 2, { ...revisions, value: '' }));
    current = await get();
    assert.equal(textOf(current, first, def), '');
    const cleared = await expectResponse(change(f, editor, 'DELETE', valuePath(first, def), 3, revisions), 204);
    assert.equal(cleared.headers[relationshipParentRevisionHeader], '4');
    assert.equal(textOf(await get(), first, def), undefined);
    assert.equal(textOf(await get(), second, def), '0');
    const command = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    for (const collection of ['events', 'auditEntries']) {
      const records = await f.db.collection(collection).find({ ...f.scope, commandId: command.id }).toArray();
      assert.equal(records.length, 1);
      assert.ok(!JSON.stringify(records).includes('🧪'));
    }
  });
});

test('project templates, local ordering, promotion and confirmed deletion preserve unrelated exact fields', { timeout: 125_000 }, async () => {
  await workspace(async (f) => {
    const { template, first, second, def, val } = await seedLinked(f);
    const editor = await signIn(f, ids.firstEditor);
    const manager = await signIn(f, ids.privateOwner);
    const newTemplate = (await data(change(f, manager, 'POST', project() + '/field-templates', 1, { name: '  New template  ' }), 201)).group;
    assert.equal(newTemplate.name, 'New template');
    const made = await data(change(f, editor, 'POST', card() + '/field-groups', 1, {
      name: 'Local', beforeGroupId: second, orderVersion: 1,
    }), 201);
    assert.equal(made.groupOrderVersion, 2);
    const local = made.group.id;
    await expectResponse(change(f, editor, 'POST', group(local) + '/fields', 1, {
      name: 'Foreign anchor', beforeFieldId: def, orderVersion: 1,
    }), 409, 'FIELD_ORDER_CONFLICT');
    const entry = await data(change(f, editor, 'POST', group(local) + '/fields', 1, { name: 'Local data', showOnFront: true }), 201);
    const sibling = await data(change(f, editor, 'POST', group(local) + '/fields', 2, { name: 'Later definition' }), 201);
    await expectResponse(change(f, editor, 'PATCH', field(sibling.definition.id), 1, {
      groupId: local, beforeFieldId: entry.definition.id, orderVersion: 2,
    }), 409, 'FIELD_ORDER_CONFLICT');
    const moved = await data(change(f, editor, 'PATCH', field(sibling.definition.id), 1, {
      groupId: local, beforeFieldId: entry.definition.id, orderVersion: 3,
    }));
    assert.equal(moved.orderVersion, 4);
    assert.deepEqual((await data(f.call(card(), editor))).fields.find(({ id }) => id === local).definitions.map(({ id }) => id),
      [sibling.definition.id, entry.definition.id]);
    await expectResponse(change(f, editor, 'POST', group(second) + '/promote', 1, { projectRevision: 2 }), 403);
    const promoted = (await data(change(f, manager, 'POST', group(second) + '/promote', 1, { projectRevision: 2 }), 201)).group;
    assert.equal(promoted.name, 'Release template');
    assert.ok(promoted.definitions.every(({ id, inherited }) => id !== def && !inherited));
    assert.equal(textOf(await data(f.call(card(), editor)), second, def), '0');
    assert.equal(await f.db.collection('fieldValues').countDocuments({ ...f.scope, fieldGroupId: promoted.id }), 0);
    const foreign = await f.insert('fieldGroups', fixtureId(575), {
      scopeType: 'board', scopeId: ids.sharedBoard, templateGroupId: template, name: 'Foreign sentinel', rank: '1',
    });
    const collidingBoard = await f.insert('boards', ids.privateProject, {
      projectId: ids.privateProject, name: 'Same UUID in another collection', rank: '2048',
    });
    const collisionGroup = await f.insert('fieldGroups', fixtureId(574), {
      scopeType: 'board', scopeId: collidingBoard, templateGroupId: template, name: null, rank: '1',
    });
    const unusedBoard = await f.insert('boards', fixtureId(576), {
      projectId: ids.privateProject, name: 'Template chooser only', rank: '3072',
    });
    await expectResponse(change(f, manager, 'DELETE', group(template), 1, {}), 422);
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await expectResponse(change(f, manager, 'DELETE', group(template), 1, { confirm: true }, key), 204);
      assert.equal(result.headers['x-planner-removed-groups'], '4');
      assert.equal(result.headers['x-planner-removed-values'], '3');
      assert.equal(result.headers[relationshipParentRevisionHeader], '4');
      assert.equal(result.data, '');
    }
    const refreshed = await data(f.call(card(), editor));
    assert.equal(refreshed.fields.some(({ id }) => [template, first, second].includes(id)), false);
    assert.ok(refreshed.fields.some(({ id }) => id === local));
    assert.equal(await row(f, 'fieldValues', val), null);
    assert.ok(await row(f, 'fieldGroups', foreign));
    assert.ok(await row(f, 'fieldGroups', promoted.id));
    assert.equal(await row(f, 'fieldGroups', collisionGroup), null);
    const projectAfter = await row(f, 'projects', ids.privateProject);
    const boardAfter = await row(f, 'boards', collidingBoard);
    assert.deepEqual([projectAfter.revision, projectAfter.fieldGroupOrderVersion, boardAfter.revision, boardAfter.fieldGroupOrderVersion], [4, 4, 2, 2]);
    const removal = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey: key });
    const events = await f.db.collection('events').find({ ...f.scope, commandId: removal.id }).toArray();
    assert.deepEqual(events.map(({ boardId }) => boardId).sort(), [ids.privateBoard, collidingBoard, unusedBoard].sort());
    assert.ok(events.every(({ kind, payload }) => kind === 'board.invalidated' && Object.keys(payload).length === 0));
    await expectResponse(change(f, editor, 'DELETE', group(template), 1, { confirm: true }, key), 404);
  });
});

test('interrupted board field detach remaps inherited tuples across batches and leaves other instances intact', { timeout: 140_000 }, async () => {
  await workspace(async (f) => {
    const { first, second, def, val } = await seedLinked(f);
    const editor = await signIn(f, ids.firstEditor);
    const token = readSessionCookie(editor);
    const templateValue = await row(f, 'fieldValues', val);
    const copyCard = fixtureId(6000);
    const copyValue = fixtureId(7000);
    for (let index = 0; index < 130; index++) {
      const id = fixtureId(6000 + index);
      await f.insert('cards', id, { boardId: ids.privateBoard, listId: ids.privateActiveList,
        kind: 'board', type: 'project', name: 'Detached card ' + index, rank: String(1024 * (index + 2)) });
      await f.insert('fieldValues', fixtureId(7000 + index), {
        cardId: id, fieldGroupId: first, fieldDefinitionId: def, value: '  λ ' + index + ' ',
      });
    }
    const transfer = await planTransferredCardFieldGroup(createWorkspaceRecords(f.db, f.generationId),
      await row(f, 'fieldGroups', first),
      { id: ids.activeCard, boardId: ids.privateBoard, projectId: ids.privateProject, rank: '1024' }, f.now().toISOString());
    assert.deepEqual(transfer.effects.filter(({ collection }) => collection === 'fieldValues').map(({ id }) => id).sort(),
      [val, fixtureId(592)].sort());
    assert.ok(transfer.effects.filter(({ collection }) => collection === 'fieldValues')
      .every(({ fields }) => fields.fieldGroupId === transfer.groupId));
    assert.equal((await row(f, 'fieldValues', copyValue)).fieldGroupId, first);
    const idempotencyKey = randomUUID();
    const journal = new CommandJournal(f.gate, f.db, f.installationId, {
      operations: createRelationshipJournalOperations(f.db, () =>
        resolveBrowserWorkspace(f.db, f.installationId, token, f.now()), 'web', idempotencyKey),
      checkpoint(point, index) {
        if (point === 'effectApplied' && index === 256) throw new Error('test interruption between field detach batches');
      },
    });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId: 'fields.detachGroup', idempotencyKey,
      input: { id: first, expectedRevision: 1 } }), /test interruption/u);
    assert.equal(f.gate.ready, false);
    await expectResponse(f.call(card(), editor), 503);
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    const replay = (await data(change(f, editor, 'POST', group(first) + '/detach', 1, {}, idempotencyKey))).group;
    assert.deepEqual([replay.name, replay.linked, replay.localName], ['Release template', false, 'Release template']);
    const replacement = replay.definitions.find(({ name }) => name === 'Visible field');
    assert.notEqual(replacement.id, def);
    assert.equal(replacement.showOnFront, true);
    const stored = await row(f, 'fieldValues', val);
    assert.deepEqual([stored.id, stored.createdAt, stored.value, stored.fieldGroupId, stored.fieldDefinitionId],
      [templateValue.id, templateValue.createdAt, templateValue.value, first, replacement.id]);
    assert.deepEqual([(await row(f, 'fieldValues', copyValue)).fieldDefinitionId, (await row(f, 'cards', copyCard)).revision], [replacement.id, 2]);
    assert.deepEqual([(await row(f, 'fieldValues', fixtureId(591))).fieldDefinitionId,
      textOf(await data(f.call(card(), editor)), second, def)], [def, '0']);
    assert.equal(await f.db.collection('fieldValues').countDocuments({ ...f.scope, fieldGroupId: first, fieldDefinitionId: replacement.id }), 131);
  });
});
