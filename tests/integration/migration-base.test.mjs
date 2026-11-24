import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { getLocalAccount } from '../../apps/backend/dist/application/auth/accounts.js';
import { importRunKey, migrationCursors } from '../../apps/backend/dist/application/migration/checkpoint.js';
import { MigrationError } from '../../apps/backend/dist/application/migration/manifest.js';
import { inspectMigration, withMigrationSnapshot } from '../../apps/backend/dist/application/migration/preflight.js';
import { sourceColumns } from '../../apps/backend/dist/application/migration/source-catalog.js';
import { stageBaseWorkspace } from '../../apps/backend/dist/application/migration/stage-base.js';
import { createWorkspaceAuthorization } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createChecklistReads } from '../../apps/backend/dist/application/workspace/checklist-reads.js';
import { projectFieldGroup } from '../../apps/backend/dist/application/workspace/field-state.js';
import { createWorkspaceRecords } from '../../apps/backend/dist/application/workspace/records.js';
import { legacyPublicId, workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { openActiveWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { assembleSnapshot } from '../fixtures/planka/snapshot.mjs';
import { startFixturePostgres } from '../fixtures/planka/private-postgres.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';

const owner = { uid: process.getuid(), gid: process.getgid() };
const filenames = ['manifest.json', 'asset-manifest.json'];
const refuses = (fault) => (error) => error?.fault === fault;

async function privateAssets(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await privateAssets(path);
    else await chmod(path, 0o600);
  }
}

async function configureSource(root, postgres, tag) {
  const suffix = tag.replaceAll('.', '');
  const database = 'planka_base_' + suffix;
  const directory = join(root, suffix);
  await mkdir(directory, { mode: 0o700 });
  for (const filename of filenames) {
    const bytes = await readFile(new URL('../fixtures/planka/' + tag + '/' + filename, import.meta.url));
    await writeFile(join(directory, filename), bytes, { mode: 0o600 });
  }
  const assets = join(directory, 'assets');
  await cp(new URL('../fixtures/planka/' + tag + '/assets/', import.meta.url), assets, { recursive: true });
  await privateAssets(assets);
  const dump = assembleSnapshot(tag);
  await writeFile(join(directory, 'source.sql'), dump, { mode: 0o600 });
  postgres.createDatabase(database);
  const update = (sql) => postgres.write(database, sql);
  update(dump);
  update('REVOKE TEMPORARY ON DATABASE ' + database + ' FROM PUBLIC');
  for (const [table, columns] of Object.entries(sourceColumns)) {
    update('GRANT SELECT (' + columns.map((column) => '"' + column + '"').join(',') +
      ') ON TABLE public."' + table + '" TO fixture_reader');
  }
  const passwordAllowed = postgres.query(database, "SELECT pg_catalog.has_column_privilege('public.user_account','password','SELECT')");
  assert.equal(passwordAllowed, 'f');
  const config = ['[fixture]', 'host=' + postgres.socketRoot, 'port=' + postgres.port, 'dbname=' + database,
    'user=fixture_reader', 'isolated=true'].join('\n');
  const input = { manifest: join(directory, 'manifest.json'), sourceService: 'fixture', assetsRoot: assets };
  return { input, config, update, query: (sql) => postgres.query(database, sql) };
}

async function createRun(db, installationId, receipt) {
  const identity = { runId: randomUUID(), generationId: randomUUID(), installationId, fingerprint: receipt.fingerprint };
  const { instanceId, release, edition } = receipt.capture.source;
  const createdAt = new Date(receipt.capture.capturedAt);
  await db.collection('importRuns').insertOne({ ...importRunKey(identity), state: 'preflighted', fingerprint: identity.fingerprint,
    manifestSha256: receipt.manifestSha256, createdAt, updatedAt: createdAt, checkpoint: null, source: { instanceId, release, edition } });
  return identity;
}

async function runStage(source, identity, db, lease, cursors, batchSize = 2) {
  return (await withMigrationSnapshot(source.input, owner, source.config, undefined, { expectedFingerprint: identity.fingerprint.sha256 },
    (snapshot) => stageBaseWorkspace(db, lease, identity, snapshot, cursors, batchSize))).value;
}

async function loadTarget(fixture, callback) {
  const { db, directory } = fixture;
  const installationId = randomUUID();
  const activeGenerationId = randomUUID();
  const writer = join(directory, 'writer');
  await mkdir(writer, { mode: 0o750 });
  await chmod(writer, 0o750);
  const setup = { mode: 'import', pendingAction: 'migration-preflight', enrollmentGenerationId: null };
  await db.collection('installation').insertOne({ _id: 'installation', installationId, schemaVersion: 0, activeGenerationId, setup });
  await migrateStorageSchema(db, installationId);
  const lease = acquireWriterDirectory(writer, owner, owner);
  try { return await callback({ db, installationId, activeGenerationId, lease, cursors: migrationCursors(randomBytes(32)) }); }
  finally { lease.release(); }
}

function interruptCheckpoint(db, interruptedPass, interruptedTable) {
  return new Proxy(db, { get(target, property) {
    if (property !== 'collection') return Reflect.get(target, property, target);
    return (name, ...options) => {
      const collection = target.collection(name, ...options);
      if (name !== 'importRuns') return collection;
      return new Proxy(collection, { get(rows, operation) {
        if (operation === 'updateOne') return async (query, update, settings) => {
          const { pass, table } = update.$set.checkpoint;
          if (pass === interruptedPass && table === interruptedTable) throw new MigrationError('target-write', 'Interrupted after staged effects.');
          return rows.updateOne(query, update, settings);
        };
        const value = Reflect.get(rows, operation, rows);
        return typeof value === 'function' ? value.bind(rows) : value;
      } });
    };
  } });
}

function publicIds(instanceId) {
  return (entity, sourceId) => legacyPublicId(instanceId, entity, sourceId);
}

async function assertGraph({ db, receipt, generationId, activeGenerationId }) {
  const id = publicIds(receipt.capture.source.instanceId);
  const scoped = { generationId };
  const instant = new Date(receipt.capture.capturedAt);
  const get = (name, entity, sourceId) => db.collection(name).findOne({ ...scoped, id: id(entity, sourceId) }, { promoteLongs: false });
  const count = (name) => db.collection(name).countDocuments(scoped);
  const counts = { users: 5, projects: 2, projectManagers: 2, boards: 2, boardPreferences: 2, boardMembers: 5, lists: 7, cards: 6,
    sessions: 0, trustedDevices: 0, oauthArtifacts: 0, recoveryGrants: 0, auditEntries: 0, events: 0, commands: 0 };
  for (const [name, expected] of Object.entries(counts)) assert.equal(await count(name), expected, name);
  const relationships = { labels: 1, cardLabels: 1, cardAssignees: 1, boardFollows: 1, cardFollows: 1,
    projectFavorites: 1, checklists: 1, tasks: 3, fieldGroups: 3, fieldDefinitions: 1, fieldValues: 2,
    activities: 0, notifications: 0 };
  for (const [name, expected] of Object.entries(relationships)) assert.equal(await count(name), expected, name);
  const mappedCount = ['action', 'attachment', 'background_image', 'base_custom_field_group', 'board', 'board_membership',
    'board_subscription', 'card', 'card_label', 'card_membership', 'card_subscription', 'comment', 'custom_field', 'custom_field_group',
    'custom_field_value', 'label', 'list', 'notification', 'project', 'project_favorite', 'project_manager', 'task', 'task_list',
    'uploaded_file', 'user_account'].reduce((sum, name) => sum + Number(receipt.rows[name]), 0);
  assert.equal(await count('importIds'), mappedCount);
  const iris = await get('users', 'user_account', '101');
  const ownerUser = await get('users', 'user_account', '102');
  const disabled = await get('users', 'user_account', '105');
  assert.deepEqual(iris.localAuth, { passwordVerifier: null, credentialsVersion: 1, mfa: 'enrollment-required' });
  assert.equal(iris.requiresMfaEnrollment, true);
  assert.equal(iris.preferences.followOwnCards, true);
  assert.equal(iris.preferences.showFavorites, false);
  assert.equal(ownerUser.username, null);
  assert.equal(ownerUser.normalizedUsername, null);
  assert.deepEqual(ownerUser.createdAt, instant);
  assert.deepEqual(disabled.disabledAt, instant);
  assert.equal(disabled.role, 'boardUser');
  assert.equal(getLocalAccount(iris), null);
  assert.equal(getLocalAccount(ownerUser), null);
  assert.equal(iris.createdAt.toISOString(), '2026-02-11T08:09:10.123Z');
  assert.equal((await get('importIds', 'user_account', '101')).provenance.createdAt, '2026-02-11T08:09:10.123456Z');
  assert.equal((await get('importIds', 'user_account', '102')).provenance.createdAt, null);
  assert.equal((await get('users', 'user_account', '103')).preferences.highlightRecentlyChanged, false);

  const archived = await get('cards', 'card', '9007199254740996');
  const archivedMapping = await get('importIds', 'card', '9007199254740996');
  assert.equal(archived.kind, 'archive');
  assert.equal(archived.rank, null);
  assert.equal(archived.closed, true);
  assert.equal(archived.previousListId, null);
  assert.equal(archivedMapping.provenance.previousListSourceId, '499');
  assert.equal(archivedMapping.provenance.listChangedAt, '2026-02-14T08:09:10.000001Z');
  const trash = await get('cards', 'card', '9007199254740997');
  assert.ok(trash.historySequence.compare(archived.historySequence) > 0);
  assert.equal(trash.previousListId, id('list', '401'));
  const alignment = await get('cards', 'card', '9007199254740993');
  const drift = await get('cards', 'card', '9007199254740994');
  assert.equal(alignment.rank.toString(), '1024');
  assert.equal(drift.rank.toString(), '2048');
  assert.equal(alignment.dueDate.toISOString(), '2026-02-12T08:09:10.654Z');
  assert.equal(alignment.dueDateCompleted, false);
  assert.deepEqual(alignment.stopwatch, { startedAt: null, total: 0 });
  assert.equal(alignment.coverAttachmentId, id('attachment', '601'));
  assert.equal(drift.dueDate, null);
  assert.equal(drift.dueDateCompleted, null);
  assert.equal(alignment.description, 'Ask @[Teal Fixture](104) and retain @[Past Observer](999).');
  assert.equal((await get('boards', 'board', '301')).historySequence.toString(), '5');
  assert.equal((await get('lists', 'list', '404')).name, 'Trash');
  assert.equal((await get('lists', 'list', '403')).name, 'Archive');
  const options = await db.collection('boardPreferences').findOne({ ...scoped, boardId: id('board', '302') });
  assert.deepEqual([options.defaultView, options.defaultCardType, options.restrictedCardType, options.showCreator,
    options.showCardAge, options.showCardCount, options.expandChecklists], ['list', 'story', 'story', false, false, false, true]);

  const role = (actor, role) => createWorkspaceAuthorization(db, generationId, { id: id('user_account', actor), role });
  const asAdmin = role('101', 'admin');
  const asOwner = role('102', 'projectOwner');
  const ownerProject = await asOwner.requireProject(id('project', '202'));
  assert.equal(ownerProject.project.hidden, true);
  assert.equal(ownerProject.project.type, 'private');
  assert.equal(ownerProject.manager.id, id('project_manager', '222'));
  assert.equal(ownerProject.project.ownerProjectManagerId, ownerProject.manager.id);
  assert.equal(ownerProject.ownsProject, true);
  assert.equal((await asOwner.requireBoard(id('board', '302'))).permissions.canEdit, true);
  await assert.rejects(asAdmin.requireBoard(id('board', '302')), { code: 'NOT_FOUND' });
  const visible = await asAdmin.requireBoard(id('board', '301'));
  assert.equal(visible.permissions.canEdit, true);
  assert.equal(visible.permissions.canManage, false);
  for (const [user, canComment] of [['103', true], ['104', false]]) {
    const board = await role(user, 'boardUser').requireBoard(id('board', '301'));
    assert.equal(board.permissions.canComment, canComment);
    assert.equal(board.permissions.canEdit, false);
    await assert.rejects(role(user, 'boardUser').requireBoard(id('board', '302')), { code: 'NOT_FOUND' });
  }
  assert.equal((await get('boardMembers', 'board_membership', '311')).canComment, null);
  const cardId = alignment.id;
  const boardId = id('board', '301');
  const label = await get('labels', 'label', '501');
  assert.equal(label.name, null);
  assert.equal(label.rank.toString(), '1024');
  assert.equal((await get('cardLabels', 'card_label', '511')).labelId, label.id);
  assert.equal((await get('projectFavorites', 'project_favorite', '231')).userId, id('user_account', '103'));
  assert.equal((await get('boardFollows', 'board_subscription', '321')).userId, id('user_account', '103'));
  assert.equal((await get('cardAssignees', 'card_membership', '521')).userId, ownerUser.id);
  const follower = await get('cardFollows', 'card_subscription', '531');
  assert.equal(follower.userId, id('user_account', '103'));
  assert.equal(follower.isPermanent, true);
  assert.equal(await db.collection('cardFollows').countDocuments({ generationId, userId: ownerUser.id }), 0);

  const records = createWorkspaceRecords(db, generationId);
  const viewer = role('103', 'boardUser');
  const [viewerChecklist] = await createChecklistReads(records, viewer).list(cardId, boardId);
  const [ownerChecklist] = await createChecklistReads(records, asOwner).list(cardId, boardId);
  assert.equal(viewerChecklist.id, id('task_list', '541'));
  assert.equal(viewerChecklist.showOnFront, true);
  assert.equal(viewerChecklist.hideCompleted, true);
  assert.deepEqual(viewerChecklist.tasks.map(({ kind, rank }) => [kind, rank]),
    [['linked', '1024'], ['unavailable', '2048'], ['task', '3072']]);
  assert.equal(viewerChecklist.tasks[0].linkedCard.completed, true);
  assert.deepEqual(Object.keys(viewerChecklist.tasks[1]).sort(), ['checklistId', 'createdAt', 'id', 'kind', 'rank', 'revision', 'updatedAt']);
  assert.deepEqual(ownerChecklist.tasks.map(({ kind }) => kind), ['linked', 'linked', 'task']);
  assert.equal(ownerChecklist.tasks[1].linkedCard.id, id('card', '9007199254740998'));
  assert.deepEqual(ownerChecklist.tasks[2].assignee, { id: ownerUser.id, name: ownerUser.name, username: null });

  const baseId = id('base_custom_field_group', '561');
  const definitionId = id('custom_field', '581');
  for (const [sourceId, valueId, scope, text] of [['571', '591', 'board', '  blue / λ  '], ['572', '592', 'card', '0']]) {
    const group = await get('fieldGroups', 'custom_field_group', sourceId);
    assert.equal(group.name, null);
    assert.equal(group.scopeType, scope);
    assert.equal(group.templateGroupId, baseId);
    const resolved = await viewer.requireCardField(cardId, group.id, definitionId);
    assert.equal(resolved.definition.fieldGroupId, baseId);
    const projected = await projectFieldGroup(records, generationId, group, id('project', '201'));
    assert.equal(projected.name, 'Spectral notes');
    assert.equal(projected.definitions[0].fieldGroupId, group.id);
    assert.equal(projected.definitions[0].inherited, true);
    const value = await get('fieldValues', 'custom_field_value', valueId);
    assert.deepEqual([value.cardId, value.fieldGroupId, value.fieldDefinitionId, value.value], [cardId, group.id, definitionId, text]);
  }
  assert.equal((await db.collection('installation').findOne({ _id: 'installation' })).activeGenerationId, activeGenerationId);
  return alignment.id;
}

async function inspect(source) {
  return inspectMigration(source.input, owner, source.config);
}

test('both verified Community captures stage the exact inactive core graph with replay-safe ranks and credentials excluded', async (t) => {
  const root = await mkdtemp(join(homedir(), '.planner-base-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const postgres = await startFixturePostgres(t, root);
  postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
  await withFixtureMongo((fixture) => loadTarget(fixture, async (target) => {
    const { db, installationId, lease, cursors } = target;
    const first = await configureSource(root, postgres, '2.3.0');
    const second = await configureSource(root, postgres, '2.3.1');
    first.update("UPDATE public.user_account SET password='synthetic-ineligible' WHERE id=101");
    const firstReceipt = await inspect(first);
    const secondReceipt = await inspect(second);
    const firstRun = await createRun(db, installationId, firstReceipt);
    const id = publicIds(firstReceipt.capture.source.instanceId);
    const cardId = id('card', '9007199254740993');
    await assert.rejects(runStage(first, firstRun, interruptCheckpoint(db, 'base', 'card'), lease, cursors), refuses('target-write'));
    const firstCardKey = { _id: workspaceKey(firstRun.generationId, cardId) };
    const stagedCards = db.collection('cards');
    assert.equal(await stagedCards.countDocuments({ generationId: firstRun.generationId }), 2);
    const saved = await db.collection('importRuns').findOne(importRunKey(firstRun));
    assert.equal(saved.checkpoint.pass, 'base');
    assert.equal(saved.checkpoint.table, 'board');
    await stagedCards.updateOne(firstCardKey, { $set: { name: 'Different staged row' } });
    await assert.rejects(runStage(first, firstRun, db, lease, cursors), refuses('target-write'));
    assert.equal((await stagedCards.findOne(firstCardKey)).name, 'Different staged row');
    await stagedCards.updateOne(firstCardKey, { $set: { name: 'Rotate the test prism' } });
    await assert.rejects(runStage(first, firstRun, interruptCheckpoint(db, 'deferred', 'custom_field_value'), lease, cursors),
      refuses('target-write'));
    const interruptedFields = await db.collection('importRuns').findOne(importRunKey(firstRun));
    assert.equal(interruptedFields.checkpoint.table, 'custom_field_group');
    assert.equal(await db.collection('fieldValues').countDocuments({ generationId: firstRun.generationId }), 2);
    const complete = await runStage(first, firstRun, db, lease, cursors);
    assert.equal(complete.pass, 'deferred');
    assert.equal(complete.table, 'task_list');
    assert.deepEqual(await runStage(first, firstRun, db, lease, cursors, 1), complete);
    const firstId = await assertGraph({ ...target, receipt: firstReceipt, generationId: firstRun.generationId });
    const repeat = await createRun(db, installationId, firstReceipt);
    await runStage(first, repeat, db, lease, cursors, 1);
    assert.equal(await assertGraph({ ...target, receipt: firstReceipt, generationId: repeat.generationId }), firstId);
    assert.notEqual((await stagedCards.findOne({ id: firstId, generationId: repeat.generationId }))._id, firstCardKey._id);
    const otherPin = await createRun(db, installationId, secondReceipt);
    await runStage(second, otherPin, db, lease, cursors, 3);
    assert.notEqual(await assertGraph({ ...target, receipt: secondReceipt, generationId: otherPin.generationId }), firstId);
    assert.equal(await (await openActiveWorkspace(db, installationId)).read('cards', firstId), null);
    assert.equal(first.query('SELECT count(*) FROM public.card'), '6');
    assert.equal(second.query('SELECT count(*) FROM public.card'), '6');
  }));
});

test('staging preserves exact gradient and history provenance and blocks malformed active relationships', async (t) => {
  const root = await mkdtemp(join(homedir(), '.planner-base-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const postgres = await startFixturePostgres(t, root);
  postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
  await withFixtureMongo((fixture) => loadTarget(fixture, async (target) => {
    const { db, installationId, lease, cursors, activeGenerationId } = target;
    const source = await configureSource(root, postgres, '2.3.1');
    const preflight = await inspect(source);
    function stage(identity, driver = db) { return runStage(source, identity, driver, lease, cursors); }
    function update(sql) { source.update(sql); }
    update(`
      UPDATE public.project SET background_type='gradient', background_gradient='ocean-dive' WHERE id=201;
      UPDATE public.project SET background_type='gradient', background_gradient='unrecognized-fixture-shade' WHERE id=202;
      UPDATE public.user_account SET default_editor_mode='unrecognized-fixture-editor' WHERE id=102;
      UPDATE public.card SET list_id=403, list_changed_at='2026-02-14 08:09:10.000001' WHERE id=9007199254740997;
      UPDATE public.card SET stopwatch='{"startedAt":"2026-02-13T08:09:10.123456Z","total":42}' WHERE id=9007199254740993;
    `);
    const revised = await inspect(source);
    const valid = await createRun(db, installationId, revised);
    const generationId = valid.generationId;
    const id = publicIds(revised.capture.source.instanceId);
    assert.notEqual(revised.fingerprint.sha256, preflight.fingerprint.sha256);
    await stage(valid);
    const project = (sourceId) => db.collection('projects').findOne({ generationId, id: id('project', sourceId) });
    const provenance = async (entity, sourceId) => (await db.collection('importIds').findOne({ generationId, entity, sourceId })).provenance;
    assert.equal((await project('201')).backgroundPreset, 'harbor');
    assert.equal((await project('201')).backgroundId, null);
    assert.equal((await provenance('project', '201')).backgroundGradient, 'ocean-dive');
    assert.equal((await project('202')).backgroundPreset, null);
    assert.equal((await provenance('project', '202')).backgroundType, 'gradient');
    assert.equal((await provenance('project', '202')).backgroundGradient, 'unrecognized-fixture-shade');
    assert.equal((await provenance('project', '202')).unrecognizedGradient, true);
    const user = await db.collection('users').findOne({ generationId, id: id('user_account', '102') });
    assert.equal(user.preferences.editorMode, 'wysiwyg');
    assert.deepEqual((await provenance('user_account', '102')).unsupportedPreferences, ['editorMode']);
    const card = await db.collection('cards').findOne({ generationId, id: id('card', '9007199254740993') });
    assert.deepEqual(card.stopwatch, { startedAt: '2026-02-13T08:09:10.123Z', total: 42 });
    assert.equal((await provenance('card', '9007199254740993')).stopwatchStartedAt, '2026-02-13T08:09:10.123456Z');
    const history = await db.collection('cards').find({ generationId, listId: id('list', '403') })
      .sort({ listChangedAt: -1, historySequence: -1 }).toArray();
    assert.deepEqual(history.map(({ id }) => id), ['9007199254740997', '9007199254740996'].map((sourceId) => id('card', sourceId)));
    assert.deepEqual(history.map(({ rank }) => rank), [null, null]);

    update(`
      UPDATE public.project SET background_type='image', background_image_id=299 WHERE id=202;
      UPDATE public.card SET cover_attachment_id=699 WHERE id=9007199254740998;
    `);
    const dangling = await createRun(db, installationId, await inspect(source));
    await stage(dangling);
    const danglingScope = { generationId: dangling.generationId };
    const missingProject = await db.collection('projects').findOne({ ...danglingScope, id: id('project', '202') });
    const missingCard = await db.collection('cards').findOne({ ...danglingScope, id: id('card', '9007199254740998') });
    assert.equal(missingProject.backgroundId, null);
    assert.equal(missingCard.coverAttachmentId, null);
    const unresolved = async (id) => (await db.collection('importIds').findOne({ ...danglingScope, id })).provenance;
    assert.deepEqual((await unresolved(missingProject.id)).backgroundReference, { sourceId: '299', unresolved: 'missing-source-record' });
    assert.deepEqual((await unresolved(missingCard.id)).coverReference, { sourceId: '699', unresolved: 'missing-source-record' });
    update(`
      UPDATE public.project SET background_type='gradient', background_image_id=NULL WHERE id=202;
      UPDATE public.card SET cover_attachment_id=NULL WHERE id=9007199254740998;
    `);

    const badRows = [
      ["UPDATE public.project SET owner_project_manager_id=221 WHERE id=202", 'source-read', 'different workspace scope'],
      ["UPDATE public.board_membership SET project_id=202 WHERE id=313", 'source-read', 'different workspace scope'],
      ["UPDATE public.board_membership SET user_id=999 WHERE id=313", 'source-read', 'typed source reference'],
      ["UPDATE public.board_membership SET can_comment=NULL WHERE id=313", 'source-read', 'comment grant'],
      ["UPDATE public.user_account SET username='IRIS@planner-fixture.invalid' WHERE id=103", 'source-read', 'duplicate normalized'],
      ["UPDATE public.card SET list_id=405 WHERE id=9007199254740993", 'source-read', 'different workspace scope'],
      ["UPDATE public.project SET background_image_id=211 WHERE id=202", 'source-read', 'different workspace scope'],
      ["UPDATE public.card SET cover_attachment_id=603 WHERE id=9007199254740998", 'source-read', 'different workspace scope'],
      ["DELETE FROM public.list WHERE id=406", 'source-read', 'one archive list'],
    ];
    const undo = [
      'UPDATE public.project SET owner_project_manager_id=222 WHERE id=202',
      'UPDATE public.board_membership SET project_id=201 WHERE id=313',
      'UPDATE public.board_membership SET user_id=103 WHERE id=313',
      'UPDATE public.board_membership SET can_comment=TRUE WHERE id=313',
      "UPDATE public.user_account SET username='sage-fixture' WHERE id=103",
      'UPDATE public.card SET list_id=401 WHERE id=9007199254740993',
      'UPDATE public.project SET background_image_id=NULL WHERE id=202',
      'UPDATE public.card SET cover_attachment_id=NULL WHERE id=9007199254740998',
      "INSERT INTO public.list (id,board_id,type) VALUES (406,302,'archive')",
    ];
    for (const [index, [edit, fault, message]] of badRows.entries()) {
      update(edit);
      try {
        const bad = await createRun(db, installationId, await inspect(source));
        await assert.rejects(stage(bad), (error) => error?.fault === fault && error.message.includes(message));
        assert.equal((await db.collection('installation').findOne({ _id: 'installation' })).activeGenerationId, activeGenerationId);
        assert.equal(await db.collection('events').countDocuments({ generationId: bad.generationId }), 0);
        if (edit.includes('background_image_id') || edit.includes('cover_attachment_id')) {
          assert.equal(await db.collection('boards').countDocuments({ generationId: bad.generationId }), 0);
          assert.equal(await db.collection('cards').countDocuments({ generationId: bad.generationId }), 0);
        }
      } finally { update(undo[index]); }
    }
  }));
});

test('staged relationship reconciliation preserves exact values and fails closed on foreign or duplicate tuples', async (t) => {
  const root = await mkdtemp(join(homedir(), '.planner-relationships-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const postgres = await startFixturePostgres(t, root);
  postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
  await withFixtureMongo((fixture) => loadTarget(fixture, async ({ db, installationId, activeGenerationId, lease, cursors }) => {
    const source = await configureSource(root, postgres, '2.3.1');
    async function runForCurrentSource() {
      const receipt = await inspect(source);
      return { receipt, identity: await createRun(db, installationId, receipt) };
    }
    const stage = (identity, size) => runStage(source, identity, db, lease, cursors, size);
    source.update(`
      INSERT INTO public.label (id,board_id,position,name,color) VALUES (10,301,1024,NULL,'lagoon-blue');
      UPDATE public.task SET linked_card_id=999, name='Former destination title', is_completed=TRUE WHERE id=552;
      UPDATE public.custom_field_value SET content='' WHERE id=591;
      UPDATE public.custom_field_value SET content=repeat('λ',600) WHERE id=592;
      UPDATE public.card_subscription SET is_permanent=FALSE WHERE id=531;
    `);
    const { receipt, identity } = await runForCurrentSource();
    const id = publicIds(receipt.capture.source.instanceId);
    const { generationId } = identity;
    await stage(identity, 2);
    const get = (name, entity, sourceId) => db.collection(name).findOne({ generationId, id: id(entity, sourceId) }, { promoteLongs: false });
    assert.equal((await get('labels', 'label', '10')).rank.toString(), '1024');
    assert.equal((await get('labels', 'label', '501')).rank.toString(), '2048');
    assert.equal((await get('fieldValues', 'custom_field_value', '591')).value, '');
    assert.equal((await get('fieldValues', 'custom_field_value', '592')).value, 'λ'.repeat(600));
    assert.equal((await get('cardFollows', 'card_subscription', '531')).isPermanent, false);
    const marker = await get('tasks', 'task', '552');
    assert.deepEqual([marker.linkedUnavailable, marker.linkedCardId, marker.name, marker.completed], [true, null, null, null]);
    assert.deepEqual((await get('importIds', 'task', '552')).provenance.linkedTask, {
      sourceCardId: '999', name: 'Former destination title', completed: true, missingTarget: true,
    });
    const actor = createWorkspaceAuthorization(db, generationId, { id: id('user_account', '102'), role: 'projectOwner' });
    const [checklist] = await createChecklistReads(createWorkspaceRecords(db, generationId), actor)
      .list(id('card', '9007199254740993'), id('board', '301'));
    assert.equal(checklist.tasks[1].kind, 'unavailable');
    assert.equal(JSON.stringify(checklist.tasks[1]).includes('Former destination title'), false);

    const badRows = [
      ['UPDATE public.label SET board_id=302 WHERE id=501', 'UPDATE public.label SET board_id=301 WHERE id=501', 'card label'],
      ['UPDATE public.task SET task_list_id=999 WHERE id=553', 'UPDATE public.task SET task_list_id=541 WHERE id=553', 'source checklist'],
      ['UPDATE public.task SET assignee_user_id=105 WHERE id=553', 'UPDATE public.task SET assignee_user_id=102 WHERE id=553', 'enabled direct member'],
      ['UPDATE public.base_custom_field_group SET project_id=202 WHERE id=561',
        'UPDATE public.base_custom_field_group SET project_id=201 WHERE id=561', 'different project'],
      ['UPDATE public.custom_field_group SET card_id=9007199254740993 WHERE id=571',
        'UPDATE public.custom_field_group SET card_id=NULL WHERE id=571', 'exactly one owning scope'],
      ['UPDATE public.custom_field_value SET card_id=9007199254740994 WHERE id=592',
        'UPDATE public.custom_field_value SET card_id=9007199254740993 WHERE id=592', 'incompatible card, group or definition'],
    ];
    for (const [edit, undo, message] of badRows) {
      source.update(edit);
      try {
        const { identity: invalid } = await runForCurrentSource();
        await assert.rejects(stage(invalid, 2), (error) => error?.fault === 'source-read' && error.message.includes(message));
        assert.equal(await db.collection('events').countDocuments({ generationId: invalid.generationId }), 0);
        assert.equal((await db.collection('installation').findOne({ _id: 'installation' })).activeGenerationId, activeGenerationId);
      } finally { source.update(undo); }
    }

    const { identity: occupied } = await runForCurrentSource();
    const existingId = randomUUID();
    const fields = db.collection('fieldValues');
    const conflicting = {
      _id: workspaceKey(occupied.generationId, existingId), id: existingId, generationId: occupied.generationId, revision: 1,
      cardId: id('card', '9007199254740993'), fieldGroupId: id('custom_field_group', '571'),
      fieldDefinitionId: id('custom_field', '581'), value: 'different durable staged row', createdAt: new Date(receipt.capture.capturedAt),
    };
    await fields.insertOne(conflicting);
    await assert.rejects(stage(occupied, 2), refuses('target-write'));
    assert.deepEqual(await fields.find({ generationId: occupied.generationId }).toArray(), [conflicting]);
    assert.equal((await db.collection('importRuns').findOne(importRunKey(occupied))).checkpoint.table, 'custom_field_group');
  }));
});
