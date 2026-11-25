import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Secret, TOTP } from 'otpauth';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { activateVerifiedMigration } from '../../apps/backend/dist/application/migration/activation.js';
import { consumeMigrationAdminRecovery, issueMigrationAdminRecovery, readMigrationAdminActivationProof } from '../../apps/backend/dist/application/auth/migration-admin.js';
import { createMfaManagement } from '../../apps/backend/dist/application/auth/mfa-management.js';
import { getLocalAccount } from '../../apps/backend/dist/application/auth/accounts.js';
import { sessionCookieName } from '../../apps/backend/dist/application/auth/credentials.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { createBoardEventCursors } from '../../apps/backend/dist/application/board-events/cursor.js';
import { importRunKey, migrationCursors } from '../../apps/backend/dist/application/migration/checkpoint.js';
import { activationExpectation, assertActivationRetry, parseMigrationApproval } from '../../apps/backend/dist/application/migration/approval.js';
import { createMediaDecoder } from '../../apps/backend/dist/application/media/decoder.js';
import { catalogVariants, mediaRecords } from '../../apps/backend/dist/application/media/records.js';
import { createMediaService } from '../../apps/backend/dist/application/media/service.js';
import { MigrationError, sha256 } from '../../apps/backend/dist/application/migration/manifest.js';
import { inspectMigration, withMigrationSnapshot } from '../../apps/backend/dist/application/migration/preflight.js';
import { sourceColumns } from '../../apps/backend/dist/application/migration/source-catalog.js';
import { stageBaseWorkspace, stageMigrationWorkspace } from '../../apps/backend/dist/application/migration/stage-base.js';
import { collectMigrationVerification } from '../../apps/backend/dist/application/migration/verification.js';
import { beginMigrationVerification, migrationVerificationPage, persistMigrationVerification, persistMigrationPreflight, prepareMigrationActivation,
  publicMigrationStatus, publicMigrationVerification, readMigrationVerification, readProtectedMigrationRun, stageProtectedMigrationRun } from '../../apps/backend/dist/native/migration-state.js';
import { registerMediaRoutes } from '../../apps/backend/dist/native/media-routes.js';
import { createWorkspaceAuthorization } from '../../apps/backend/dist/application/workspace/authorization.js';
import { createWorkspaceReads } from '../../apps/backend/dist/application/workspace/reads.js';
import { rewriteImportedMentions } from '../../apps/backend/dist/application/migration/historical-mentions.js';
import { createChecklistReads } from '../../apps/backend/dist/application/workspace/checklist-reads.js';
import { eligibleBoardPeople } from '../../apps/backend/dist/application/workspace/eligible-members.js';
import { projectFieldGroup } from '../../apps/backend/dist/application/workspace/field-state.js';
import { createWorkspaceRecords } from '../../apps/backend/dist/application/workspace/records.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';
import { legacyPublicId, workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { openActiveWorkspace, openTrustedStagedWorkspace } from '../../apps/backend/dist/storage/scoped.js';
import { assertReport, sharedImageKey } from '../fixtures/planka/matrix-oracle.mjs';
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

async function configureSource(root, postgres, tag, scenario) {
  const suffix = tag.replaceAll('.', '') + (scenario ? '_' + scenario : '');
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
  const dump = assembleSnapshot(tag, scenario);
  await writeFile(join(directory, 'source.sql'), dump, { mode: 0o600 });
  if (scenario) {
    const path = join(directory, 'manifest.json');
    const capture = JSON.parse(await readFile(path, 'utf8'));
    capture.source.dumpSha256 = sha256(Buffer.from(dump));
    await writeFile(path, JSON.stringify(capture));
  }
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

function interruptCheckpoint(db, interruptedPass, interruptedTable, skip = 0) {
  return new Proxy(db, { get(target, property) {
    if (property !== 'collection') return Reflect.get(target, property, target);
    return (name, ...options) => {
      const collection = target.collection(name, ...options);
      if (name !== 'importRuns') return collection;
      return new Proxy(collection, { get(rows, operation) {
        if (operation === 'updateOne') return async (query, update, settings) => {
          const { pass, table } = update.$set.checkpoint;
          if (pass === interruptedPass && table === interruptedTable && skip-- === 0) throw new MigrationError('target-write', 'Interrupted after staged effects.');
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
  };
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
  assert.equal(alignment.description, `Ask @[Teal Fixture](${id('user_account', '104')}) and retain @[Past Observer](999).`);
  const board = await get('boards', 'board', '301');
  assert.equal(board.historySequence.toString(), '5');
  assert.equal(board.rank.toString(), '1024');
  assert.equal(board.orderVersion, 1);
  assert.equal((await get('projects', 'project', '201')).rank.toString(), '1024');
  assert.equal((await get('projects', 'project', '202')).rank.toString(), '2048');
  assert.equal((await get('projects', 'project', '201')).boardOrderVersion, 1);
  assert.equal((await get('lists', 'list', '401')).rank.toString(), '1024');
  assert.equal((await get('lists', 'list', '402')).rank.toString(), '2048');
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
  await assertDiscussionGraph(db, receipt, generationId, id);
  return alignment.id;
}

function readsFor(db, generationId, id, actor, role) {
  const access = createWorkspaceAuthorization(db, generationId, { id: id('user_account', actor), role });
  return createWorkspaceReads(db, access, createBoardEventCursors(createSecretKey(randomBytes(32))));
}

async function assertDiscussionGraph(db, receipt, generationId, id) {
  const scope = { generationId };
  const get = (name, entity, sourceId) => db.collection(name).findOne({ ...scope, id: id(entity, sourceId) });
  assert.equal(await db.collection('comments').countDocuments(scope), 1);
  assert.equal(await db.collection('activities').countDocuments(scope), 2);
  assert.equal(await db.collection('notifications').countDocuments(scope), 1);
  assert.equal(await db.collection('importQuarantine').countDocuments(scope), 1);
  const comments = await readsFor(db, generationId, id, '103', 'boardUser').cardComments({
    id: id('card', '9007199254740993'), boardId: id('board', '301'), limit: 25,
  });
  assert.equal(comments.data[0].id, id('comment', '701'));
  assert.equal(comments.data[0].author.id, id('user_account', '103'));
  assert.equal(comments.data[0].text, 'Measured twice.');
  assert.equal(comments.data[0].createdAt, '2026-02-11T09:00:00.006Z');
  assert.equal((await get('importIds', 'comment', '701')).provenance.createdAt, '2026-02-11T09:00:00.006789Z');
  const counts = (await get('importIds', 'card', '9007199254740993')).provenance;
  assert.deepEqual([counts.sourceCommentCount, counts.observedCommentCount], [1, 1]);
  const owner = readsFor(db, generationId, id, '102', 'projectOwner');
  const board = await owner.boardActivity({ id: id('board', '301'), limit: 25 });
  const archive = board.data.find((entry) => entry.id === id('action', '711'));
  const created = board.data.find((entry) => entry.id === id('action', '712'));
  assert.equal(archive.kind, 'moveCard');
  assert.equal(archive.actor, null);
  assert.equal(archive.card.id, id('card', '9007199254740996'));
  assert.equal(created.kind, 'createCard');
  assert.equal(created.actor.id, id('user_account', '102'));
  assert.equal(JSON.stringify(board).includes('Earlier batch'), false);
  const historic = (await get('importIds', 'action', '711')).provenance.discussion;
  assert.equal(historic.boardSourceId, null);
  assert.equal(historic.decoded.snapshot.fromList.id, '499');
  assert.equal(historic.decoded.snapshot.toList.id, '403');
  const own = await owner.notificationsList({ unread: false, limit: 25 });
  assert.equal(own.data.length, 1);
  assert.equal(own.data[0].id, id('notification', '722'));
  assert.equal(own.data[0].readAt, receipt.capture.capturedAt);
  assert.equal(own.unreadCount, 0);
  const quarantined = await get('importQuarantine', 'notification', '721');
  assert.deepEqual(quarantined.reasons, ['missing-card', 'missing-activity']);
  assert.equal(quarantined.sourceIsRead, false);
  const orphan = (await get('importIds', 'notification', '721')).provenance.discussion;
  assert.equal(orphan.cardSourceId, '9007199254740999');
  assert.equal(orphan.actionSourceId, '799');
  assert.deepEqual(await readsFor(db, generationId, id, '103', 'boardUser').notificationsList({ unread: false, limit: 25 }),
    { data: [], page: { nextCursor: null }, unreadCount: 0 });
}

async function inspect(source) {
  return inspectMigration(source.input, owner, source.config, source.objectConfig);
}

test('both verified Community captures stage the exact inactive core graph with replay-safe ranks and credentials excluded', async (t) => {
  const root = await mkdtemp(join(homedir(), '.planner-base-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const postgres = await startFixturePostgres(t, root);
  postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
  await withFixtureMongo((fixture) => loadTarget(fixture, async (target) => {
    const { db, installationId, lease, cursors } = target;
    const existingCard = randomUUID();
    const active = await openActiveWorkspace(db, installationId);
    await active.insert('cards', existingCard, { name: 'Existing active card' });
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
    assert.equal(complete.pass, 'projections');
    assert.equal(complete.table, 'notification');
    assert.deepEqual(await runStage(first, firstRun, db, lease, cursors, 1), complete);
    const firstId = await assertGraph({ ...target, receipt: firstReceipt, generationId: firstRun.generationId });
    const staged = await openTrustedStagedWorkspace(db, installationId, firstRun.generationId);
    const genericMapping = await staged.read('importIds', firstId);
    assert.equal(genericMapping.sourceId, '9007199254740993');
    for (const field of ['provenance', 'order', 'reference']) assert.equal(Object.hasOwn(genericMapping, field), false);
    const repeat = await createRun(db, installationId, firstReceipt);
    await runStage(first, repeat, db, lease, cursors, 1);
    assert.equal(await assertGraph({ ...target, receipt: firstReceipt, generationId: repeat.generationId }), firstId);
    assert.notEqual((await stagedCards.findOne({ id: firstId, generationId: repeat.generationId }))._id, firstCardKey._id);
    const otherPin = await createRun(db, installationId, secondReceipt);
    await runStage(second, otherPin, db, lease, cursors, 3);
    assert.notEqual(await assertGraph({ ...target, receipt: secondReceipt, generationId: otherPin.generationId }), firstId);
    assert.equal(await active.read('cards', firstId), null);
    assert.equal((await active.read('cards', existingCard)).name, 'Existing active card');
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
      UPDATE public.user_account SET default_editor_mode='unrecognized-fixture-editor', is_deactivated=true WHERE id=102;
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
    assert.notEqual(user.disabledAt, null);
    const retainedOwner = await db.collection('projectManagers').findOne({ generationId, id: id('project_manager', '222') });
    assert.equal(retainedOwner.userId, user.id);
    const retainedAssignment = await db.collection('cardAssignees').findOne({ generationId, id: id('card_membership', '521') });
    assert.equal(retainedAssignment.userId, user.id);
    const retainedTask = await db.collection('tasks').findOne({ generationId, id: id('task', '553') });
    assert.equal(retainedTask.assigneeId, user.id);
    const viewer = createWorkspaceAuthorization(db, generationId, { id: id('user_account', '103'), role: 'boardUser' });
    const [readChecklist] = await createChecklistReads(createWorkspaceRecords(db, generationId), viewer)
      .list(id('card', '9007199254740993'), id('board', '301'));
    assert.equal(readChecklist.tasks.find(({ id: taskId }) => taskId === retainedTask.id).assignee, null);
    assert.deepEqual(await eligibleBoardPeople(createWorkspaceRecords(db, generationId), generationId, id('board', '301'), { id: user.id }), []);
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
      ["UPDATE public.project SET owner_project_manager_id=229 WHERE id=202", 'source-read', 'reference is missing'],
      ["DELETE FROM public.project_manager WHERE id=221", 'source-read', 'no project manager'],
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
      'UPDATE public.project SET owner_project_manager_id=222 WHERE id=202',
      'INSERT INTO public.project_manager (id, project_id, user_id) VALUES (221,201,102)',
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
      UPDATE public.custom_field SET position=20 WHERE id=581;
      INSERT INTO public.custom_field_group (id, board_id, position, name) VALUES (573, 301, 4096, 'Standalone');
      INSERT INTO public.custom_field (id, base_custom_field_group_id, custom_field_group_id, position, name, show_on_front_of_card)
        VALUES (580,561,NULL,10,'Earlier template field',TRUE),(9007199254741999,NULL,571,30,'Board local field',TRUE),
          (2,NULL,572,20,'Card local tie',TRUE),(584,NULL,573,10,'Standalone field',TRUE);
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
    const records = createWorkspaceRecords(db, generationId);
    for (const [sourceId, ids, ranks] of [
      ['571', ['580', '581', '9007199254741999'], ['1024', '3072', '4096']],
      ['572', ['580', '2', '581'], ['1024', '2048', '3072']],
      ['573', ['584'], ['1024']],
    ]) {
      const group = await get('fieldGroups', 'custom_field_group', sourceId);
      const projected = await projectFieldGroup(records, generationId, group, id('project', '201'));
      assert.deepEqual(projected.definitions.map(({ id }) => id), ids.map((sourceId) => id('custom_field', sourceId)));
      assert.deepEqual(projected.definitions.map(({ rank }) => rank), ranks);
    }
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
      ['UPDATE public.task SET assignee_user_id=105 WHERE id=553', 'UPDATE public.task SET assignee_user_id=102 WHERE id=553', 'no direct member'],
      ['UPDATE public.task SET assignee_user_id=999 WHERE id=553', 'UPDATE public.task SET assignee_user_id=102 WHERE id=553', 'typed source reference'],
      ['UPDATE public.card_membership SET user_id=105 WHERE id=521', 'UPDATE public.card_membership SET user_id=102 WHERE id=521', 'no direct member'],
      ['UPDATE public.base_custom_field_group SET project_id=202 WHERE id=561',
        'UPDATE public.base_custom_field_group SET project_id=201 WHERE id=561', 'different project'],
      ['UPDATE public.custom_field_group SET card_id=9007199254740993 WHERE id=571',
        'UPDATE public.custom_field_group SET card_id=NULL WHERE id=571', 'exactly one owning scope'],
      ['UPDATE public.custom_field_value SET card_id=9007199254740994 WHERE id=592',
        'UPDATE public.custom_field_value SET card_id=9007199254740993 WHERE id=592', 'incompatible card, group or definition'],
      [`
        INSERT INTO public.base_custom_field_group (id, project_id, name) VALUES (562, 201, 'Other template');
        INSERT INTO public.custom_field (id, base_custom_field_group_id, position, name, show_on_front_of_card)
          VALUES (582, 562, 1024, 'Other definition', TRUE);
        UPDATE public.custom_field_value SET custom_field_id=582 WHERE id=592;
      `, `
        UPDATE public.custom_field_value SET custom_field_id=581 WHERE id=592;
        DELETE FROM public.custom_field WHERE id=582;
        DELETE FROM public.base_custom_field_group WHERE id=562;
      `, 'incompatible card, group or definition'],
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

    const { identity: mismatched } = await runForCurrentSource();
    await assert.rejects(runStage(source, mismatched, interruptCheckpoint(db, 'base', 'board'), lease, cursors), refuses('target-write'));
    await db.collection('importIds').updateOne({ generationId: mismatched.generationId, entity: 'task_list', sourceId: '541' },
      { $set: { 'reference.parent': '9007199254740994' } });
    await assert.rejects(stage(mismatched, 2), (error) => error?.fault === 'target-write' && error.message.includes('protected relationship parent'));
    assert.equal(await db.collection('checklists').countDocuments({ generationId: mismatched.generationId }), 0);

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

test('legacy mention rewriting replaces only recognized text tokens while retaining escapes and literal contexts', async () => {
  const known = '9007199254740993';
  const current = randomUUID();
  const lookups = [];
  const store = { async resolve(entity, id) {
    assert.equal(entity, 'user_account');
    lookups.push(id);
    return id === known ? current : null;
  } };
  const recognized = String.raw`@[T\[eal\] \\ member](${known})`;
  const escaped = String.raw`\@[escaped](${known})`;
  const code = '`@[inline](' + known + ')`';
  const linkedText = '[@[link label](' + known + ')](https://fixture.invalid/)';
  const rawUrl = 'https://fixture.invalid/@[slug](' + known + ')';
  const twoFences = ['```fixture', '@[fenced](' + known + ')', '```', '~~~', '@[tilde](' + known + ')', '~~~'].join('\n');
  const unresolved = '@[Past Observer](999)';
  const invalid = '@[Invalid](09007199254740993)';
  const indented = ['    @[four spaces](' + known + ')', '\t@[tab](' + known + ')'].join('\n');
  const nested = ['> ```note', '> @[quote](' + known + ')', '> ```', '- ~~~', '  @[list](' + known + ')', '  ~~~'].join('\n');
  const malformed = '@[missing end](' + known;
  const text = [recognized + recognized, escaped, code, linkedText, rawUrl, twoFences, '', indented, '', nested,
    recognized, unresolved, invalid, malformed].join('\n');
  const expected = text.replaceAll(recognized, recognized.replace(known, current));
  assert.equal(await rewriteImportedMentions(text, store), expected);
  assert.deepEqual(lookups, [known, '999']);
  const raw = JSON.stringify({ fixture: '@[json](' + known + ')' });
  assert.equal(await rewriteImportedMentions(raw, store), raw);

  const literalContexts = [
    '- > ~~~\n  > ' + recognized + '\n  > ~~~',
    '~~~\nx\n    ~~~\n' + recognized + '\n~~~',
    '![' + recognized + '](https://fixture.invalid/image.png)',
    'mailto:fixture/' + recognized,
    '```\n' + recognized + '\n```\n@[Existing](00000000-0000-4000-8000-000000000000)',
  ];
  for (const literal of literalContexts) assert.equal(await rewriteImportedMentions(literal, store), literal);

  const paragraphContexts = [
    'This is a paragraph\r\n    ' + recognized,
    '`foo\n\nbar ' + recognized + ' `',
    '[guide](https://fixture.invalid/)—' + recognized,
    '`https://fixture.invalid/`' + recognized,
    '[contact](mailto:contact@example.invalid)' + recognized,
  ];
  for (const paragraph of paragraphContexts) {
    assert.equal(await rewriteImportedMentions(paragraph, store), paragraph.replace(known, current));
  }
});

test('staged discussions validate every kind, retain private snapshots and admit only scoped historical deliveries', async (t) => {
  const root = await mkdtemp(join(homedir(), '.planner-base-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const postgres = await startFixturePostgres(t, root);
  postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
  await withFixtureMongo((fixture) => loadTarget(fixture, async (target) => {
    const { db, installationId, lease, cursors } = target;
    const source = await configureSource(root, postgres, '2.3.1');
    source.update(`
      INSERT INTO public.comment (id,card_id,user_id,text,created_at) VALUES
      (702,9007199254740998,999,'Private remark only','2026-02-13 12:45:00.026789'),
      (703,9007199254740993,NULL,repeat('λ',8101) || chr(10) || 'Exact @[Teal Fixture](104) and @[Past Observer](999).','2026-02-13 12:45:00.036789');
      INSERT INTO public.action (id,board_id,card_id,user_id,type,data) VALUES
      (713,301,9007199254740993,102,'addMemberToCard','{"card":{"name":"Old card heading"},"user":{"id":"103","name":"Assignment snapshot"}}'),
      (714,301,9007199254740993,102,'removeMemberFromCard','{"card":{"name":"Old card heading"},"user":{"id":"104","name":"Former assignee"}}'),
      (715,301,9007199254740993,102,'completeTask','{"card":{"name":"Old card heading"},"task":{"id":"551","name":"Completed detail"}}'),
      (716,301,9007199254740993,999,'uncompleteTask','{"card":{"name":"Old card heading"},"task":{"id":"599","name":"Former task"}}'),
      (717,301,9007199254740993,102,'inventedFixtureKind','{"ignore":"Unrecognized payload"}'),
      (718,301,9007199254740993,102,'createCard','{"card":{"name":"Invalid payload","id":"9007199254740998"},"list":{"id":"401","type":"active","name":"Align"}}'),
      (719,302,9007199254740993,102,'moveCard','{"fromList":{"id":"405","type":"active","name":"Private prior list"},"toList":{"id":"401","type":"active","name":"Align"}}'),
      (720,NULL,9007199254740999,NULL,'moveCard','{"fromList":{"id":"499","type":"closed","name":"Private missing-card list"},"toList":{"id":"401","type":"active","name":"Align"}}');
      INSERT INTO public.notification (id,user_id,creator_user_id,board_id,card_id,comment_id,action_id,type,data,is_read,updated_at) VALUES
      (723,103,102,301,9007199254740993,NULL,713,'addMemberToCard','{"card":{"name":"Old card heading"},"user":{"id":"103","name":"Assignment snapshot"}}',false,NULL),
      (724,104,102,301,9007199254740993,NULL,713,'addMemberToCard','{"card":{"name":"Old card heading"},"user":{"id":"103","name":"Assignment snapshot"}}',false,NULL),
      (725,103,NULL,302,9007199254740998,702,NULL,'commentCard','{"card":{"name":"Private card"},"text":"Private remark only"}',true,NULL),
      (726,104,103,301,9007199254740993,701,712,'commentCard','{"card":{"name":"Old card heading"},"text":"Old comment"}',false,NULL),
      (727,103,102,301,9007199254740993,NULL,712,'moveCard','{"fromList":{"id":"402","type":"closed","name":"Measured"},"toList":{"id":"401","type":"active","name":"Align"}}',false,NULL),
      (728,104,103,301,9007199254740994,701,NULL,'commentCard','{"card":{"name":"Wrong card"},"text":"Old comment"}',false,NULL),
      (729,104,103,302,9007199254740993,701,NULL,'commentCard','{"card":{"name":"Wrong board"},"text":"Old comment"}',false,NULL),
      (730,105,103,301,9007199254740993,701,NULL,'commentCard','{"card":{"name":"Disabled target"},"text":"Old comment"}',false,NULL),
      (731,104,NULL,301,9007199254740993,703,NULL,'mentionInComment','{"card":{"name":"Old card heading"},"text":"Old plain text"}',true,'2026-02-20 12:00:00.999999'),
      (732,103,102,301,9007199254740996,NULL,711,'moveCard','{"fromList":{"id":"499","type":"closed","name":"Earlier batch"},"toList":{"id":"403","type":"archive","name":null}}',true,NULL),
      (733,104,101,301,9007199254740993,701,NULL,'commentCard','{"card":{"name":"Wrong actor"},"text":"Old comment"}',false,NULL),
      (734,103,102,302,9007199254740993,NULL,719,'moveCard','{"fromList":{"id":"405","type":"active","name":"Old archived display"},"toList":{"id":"401","type":"active","name":"Different current display"}}',false,NULL),
      (735,103,102,302,9007199254740993,NULL,719,'moveCard','{"fromList":{"id":"402","type":"closed","name":"Unrelated historic move"},"toList":{"id":"401","type":"active","name":"Align"}}',false,NULL);
    `);
    const receipt = await inspect(source);
    const identity = await createRun(db, installationId, receipt);
    const { generationId } = identity;
    const id = publicIds(receipt.capture.source.instanceId);
    const scope = { generationId };
    const resumable = (driver = db, size = 1) => runStage(source, identity, driver, lease, cursors, size);
    const normal = (collection, entity, sourceId) => db.collection(collection).findOne({ ...scope, id: id(entity, sourceId) });
    await assert.rejects(resumable(interruptCheckpoint(db, 'projections', 'notification')), refuses('target-write'));
    const checkpoint = (await db.collection('importRuns').findOne(importRunKey(identity))).checkpoint;
    assert.equal(checkpoint.table, 'comment');
    assert.equal(await db.collection('importQuarantine').countDocuments({ ...scope, entity: 'notification' }), 1);
    await resumable(db, 3);
    const committed = await resumable(db, 2);
    assert.equal(committed.lastSourceId, '735');
    assert.equal(await db.collection('comments').countDocuments(scope), 3);
    assert.equal(await db.collection('activities').countDocuments(scope), 7);
    assert.equal(await db.collection('notifications').countDocuments(scope), 5);
    assert.equal(await db.collection('importQuarantine').countDocuments({ ...scope, entity: 'action' }), 3);
    assert.equal(await db.collection('importQuarantine').countDocuments({ ...scope, entity: 'notification' }), 10);
    for (const name of ['auditEntries', 'events', 'commands', 'commandEffectBatches']) {
      assert.equal(await db.collection(name).countDocuments(scope), 0);
    }

    const accessible = readsFor(db, generationId, id, '103', 'boardUser');
    const editor = readsFor(db, generationId, id, '102', 'projectOwner');
    const importedCard = id('card', '9007199254740993');
    const sourceBoard = id('board', '301');
    const targetBoard = id('board', '302');
    const matches = await accessible.cardComments({ id: importedCard, boardId: sourceBoard, limit: 25 });
    assert.equal(matches.data.length, 2);
    const retained = matches.data.find((entry) => entry.id === id('comment', '703'));
    assert.equal(retained.author, null);
    assert.equal(retained.text, 'λ'.repeat(8101) + `\nExact @[Teal Fixture](${id('user_account', '104')}) and @[Past Observer](999).`);
    const counts = (await normal('importIds', 'card', '9007199254740993')).provenance;
    assert.deepEqual([counts.sourceCommentCount, counts.observedCommentCount], [1, matches.data.length]);
    const unknownAuthor = await normal('comments', 'comment', '702');
    assert.equal(unknownAuthor.authorId, null);
    assert.equal((await normal('importIds', 'comment', '702')).provenance.discussion.authorSourceId, '999');
    await assert.rejects(accessible.cardComments({ id: id('card', '9007199254740998'), boardId: targetBoard, limit: 25 }), { code: 'NOT_FOUND' });

    const feed = await accessible.boardActivity({ id: sourceBoard, limit: 25 });
    assert.deepEqual([...new Set(feed.data.map(({ kind }) => kind))].sort(),
      ['assignCard', 'completeTask', 'createCard', 'moveCard', 'unassignCard', 'uncompleteTask']);
    assert.equal(feed.data.find(({ id: activityId }) => activityId === id('action', '719')).actor, null);
    assert.equal(feed.data.find(({ id: activityId }) => activityId === id('action', '716')).actor, null);
    for (const word of ['Private prior list', 'Former task', 'Former assignee', 'Assignment snapshot', 'Invalid payload']) {
      assert.equal(JSON.stringify(feed).includes(word), false);
    }
    const oldAction = (await normal('importIds', 'action', '719')).provenance.discussion;
    assert.equal(oldAction.boardSourceId, '302');
    assert.equal(oldAction.decoded.snapshot.fromList.name, 'Private prior list');
    assert.equal((await normal('importQuarantine', 'action', '717')).reason, 'unsupported-kind');
    assert.equal((await normal('importQuarantine', 'action', '718')).reason, 'invalid-snapshot');
    assert.equal((await normal('importQuarantine', 'action', '720')).reason, 'missing-card');

    const own = await accessible.notificationsList({ unread: true, limit: 25 });
    assert.equal(own.data.length, 2);
    assert.equal(own.data.find((row) => row.id === id('notification', '723')).kind, 'assignCard');
    const historicalDelivery = own.data.find((row) => row.id === id('notification', '734'));
    assert.equal(historicalDelivery.kind, 'moveCard');
    assert.equal(historicalDelivery.card.boardId, sourceBoard);
    assert.equal(historicalDelivery.actor, null);
    assert.equal(JSON.stringify(historicalDelivery).includes('Old archived display'), false);
    assert.equal(own.unreadCount, 2);
    const movement = (await accessible.notificationsList({ unread: false, limit: 25 })).data.find((row) => row.id === id('notification', '732'));
    assert.equal(movement.kind, 'moveCard');
    assert.equal(movement.actor, null);
    const mention = await readsFor(db, generationId, id, '104', 'boardUser').notificationsList({ unread: false, limit: 25 });
    assert.equal(mention.data.length, 1);
    assert.equal(mention.data[0].readAt, '2026-02-20T12:00:00.999Z');
    assert.equal(mention.data[0].actor, null);
    assert.equal(mention.unreadCount, 0);
    const reasons = [['724', 'assignment-recipient-mismatch'], ['725', 'recipient-cannot-read-card'], ['726', 'target-kind-mismatch'],
      ['727', 'target-kind-mismatch'], ['728', 'target-scope-mismatch'], ['729', 'board-mismatch'], ['730', 'disabled-recipient'],
      ['733', 'target-actor-mismatch'], ['735', 'target-snapshot-mismatch']];
    for (const [sourceId, reason] of reasons) assert.ok((await normal('importQuarantine', 'notification', sourceId)).reasons.includes(reason));
    assert.equal((await normal('importQuarantine', 'notification', '725')).sourceIsRead, true);
    const staged = await openTrustedStagedWorkspace(db, installationId, generationId);
    await assert.rejects(staged.read('importQuarantine', id('notification', '725')), /available to the workspace/u);

    // Exercise current read scoping after placement and comment scope change, as in a committed board transfer.
    await db.collection('cards').updateOne({ ...scope, id: importedCard }, { $set: { boardId: targetBoard, listId: id('list', '405') } });
    await db.collection('comments').updateMany({ ...scope, cardId: importedCard }, { $set: { boardId: targetBoard } });
    const revoked = await accessible.notificationsList({ unread: false, limit: 25 });
    assert.deepEqual(revoked.data.map((row) => row.id), [id('notification', '732')]);
    assert.equal(revoked.unreadCount, 0);
    assert.equal((await accessible.boardActivity({ id: sourceBoard, limit: 25 })).data.some(({ card }) => card.id === importedCard), false);
    const newScope = await editor.cardComments({ id: importedCard, boardId: targetBoard, limit: 25 });
    assert.equal(newScope.data.length, 2);
    const transferredNotice = await editor.notificationsList({ unread: false, limit: 25 });
    assert.equal(transferredNotice.data[0].card.boardId, targetBoard);
    assert.equal(transferredNotice.data[0].actor, null);
    assert.equal(transferredNotice.unreadCount, 0);
    assert.equal(source.query('SELECT count(*) FROM public.notification'), '15');

    source.update("INSERT INTO public.comment (id,card_id,text) VALUES (799,9007199254740999,'No source parent')");
    const missingParent = await createRun(db, installationId, await inspect(source));
    await assert.rejects(runStage(source, missingParent, db, lease, cursors),
      (error) => error?.fault === 'source-read' && /no owning card/u.test(error.message));
    const failed = { generationId: missingParent.generationId };
    assert.equal(await db.collection('comments').countDocuments({ ...failed, id: id('comment', '799') }), 0);
    assert.equal(await db.collection('notifications').countDocuments(failed), 0);
    assert.equal(await db.collection('events').countDocuments(failed), 0);
  }));
});

async function frozenObjects(t, source, directory) {
  const capture = JSON.parse(await readFile(source.input.manifest, 'utf8'));
  const assetManifestPath = join(dirname(source.input.manifest), 'asset-manifest.json');
  const manifest = JSON.parse(await readFile(assetManifestPath, 'utf8'));
  const versions = new Map(manifest.files.map((file, index) => {
    file.versionId = `version_${index + 1}`;
    return [file.key, file.versionId];
  }));
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  capture.asset.kind = 'object';
  capture.asset.manifestSha256 = sha256(manifestBytes);
  await writeFile(assetManifestPath, manifestBytes);
  await writeFile(source.input.manifest, JSON.stringify(capture));
  const keyPath = join(directory, 'fixture-tls-key');
  const certPath = join(directory, 'fixture-tls-cert');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
  { stdio: 'ignore' }).status, 0);
  const cert = await readFile(certPath, 'utf8');
  const defaults = getCACertificates('default');
  setDefaultCACertificates([...defaults, cert]);
  const requests = [];
  const missing = new Set();
  const mismatched = new Set();
  const server = createServer({ cert, key: await readFile(keyPath) }, async (request, response) => {
    try {
      const url = new URL(request.url, 'https://127.0.0.1');
      const key = decodeURIComponent(url.pathname.slice('/frozen/'.length));
      const version = versions.get(key);
      requests.push({ path: url.pathname, version: url.searchParams.get('versionId') });
      if (request.method !== 'GET' || !url.pathname.startsWith('/frozen/') || !version
        || url.searchParams.get('versionId') !== version || missing.has(key)) return response.writeHead(404).end();
      const bytes = await readFile(join(source.input.assetsRoot, key));
      response.writeHead(200, { 'Content-Length': bytes.length,
        'X-Amz-Version-Id': mismatched.has(key) ? 'wrong-version' : version }).end(bytes);
    } catch { response.writeHead(500).end(); }
  });
  t.after(async () => {
    setDefaultCACertificates(defaults);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `https://127.0.0.1:${server.address().port}/frozen/`;
  const { assetsRoot: _assetsRoot, ...input } = source.input;
  return { ...source, input: { ...input, assetService: 'fixture' },
    objectConfig: JSON.stringify({ fixture: { base, snapshotId: capture.asset.snapshotId } }), requests, versions, missing, mismatched };
}

function interruptMediaStore(store, point) {
  return { ...store, async stage() {
    const stage = await store.stage();
    return { ...stage, async publish(items) {
      if (point === 'published') (await stage.publish(items.slice(0, 1)))();
      throw new MigrationError('target-write', 'Interrupted at media publication.');
    }, async dispose() { /* Simulate scratch left by a dead writer. */ } };
  } };
}

const mediaPython = process.env.PLANNER_TEST_MEDIA_PYTHON ?? undefined;
const mediaDecoderAvailable = mediaPython || spawnSync('/usr/bin/python3', ['-I', '-B', '-c', 'import PIL'], { stdio: 'ignore' }).status === 0;

async function assertApprovedUnavailableMedia(db, installationId, generationId, id, store, decode, availableBytes) {
  // Exercise the HTTP media boundary after a synthetic pointer switch and local credential setup.
  await db.collection('installation').updateOne({ _id: 'installation', installationId }, {
    $set: { activeGenerationId: generationId, 'setup.pendingAction': 'complete' },
  });
  const gate = { readSnapshot: (operation) => operation(), runCommand: (operation) => operation() };
  const hasher = createPasswordHasher();
  const password = 'Synthetic media acceptance credential';
  const passwordVerifier = await hasher.encode(password);
  const sessions = createBrowserSessions(db, installationId, gate, hasher);
  async function login(sourceId, identifier) {
    await db.collection('users').updateOne({ generationId, id: id('user_account', sourceId) },
      { $set: { 'localAuth.passwordVerifier': passwordVerifier, disabledAt: null } });
    const session = await sessions.login({ identifier, password });
    assert.equal(session.status, 'authenticated');
    return `${sessionCookieName}=${session.token}`;
  }
  const viewer = await login('103', 'sage-fixture');
  const outsider = await login('105', 'yarrow-fixture');
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.plannerConnection = { clientAddress: '127.0.0.1' };
    request.plannerSession = true;
  });
  const service = createMediaService(db, installationId, gate, store, decode);
  registerMediaRoutes(app, (run) => run(service));
  try {
    const read = (cookie, sourceId, path, method = 'GET', range) => app.inject({
      method, url: `/api/v1/attachments/${id('attachment', sourceId)}/${path}`, headers: { cookie, ...(range && { range }) },
    });
    const download = await read(viewer, '603', 'download');
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, availableBytes);
    const partial = await read(viewer, '603', 'download', 'GET', 'bytes=1-3');
    assert.equal(partial.statusCode, 206);
    assert.deepEqual(partial.rawPayload, availableBytes.subarray(1, 4));
    assert.equal((await read(outsider, '603', 'download')).statusCode, 404);
    for (const sourceId of ['601', '602']) {
      for (const [path, method, range] of [['download', 'GET'], ['download', 'HEAD'], ['download', 'GET', 'bytes=0-8'],
        ['thumbnail/small', 'GET'], ['thumbnail/large', 'HEAD']]) {
        const denied = await read(viewer, sourceId, path, method, range);
        assert.equal(denied.statusCode, 404);
        assert.equal(denied.headers['content-range'], undefined);
        assert.equal(denied.headers['content-disposition'], undefined);
        if (method === 'HEAD') assert.equal(denied.rawPayload.length, 0);
        else assert.equal(denied.json().error.code, 'NOT_FOUND');
      }
    }
  } finally { await app.close(); }
}

test('migration activation approval binds one canonical digest to the exact physical missing inventory', () => {
  const verified = { runId: randomUUID(), generationId: randomUUID(), manifestSha256: '1'.repeat(64),
    fingerprintSha256: '2'.repeat(64), reportSha256: '3'.repeat(64) };
  const missing = ['9007199254741220', '9007199254741219'].map((sourceId) => ({ type: 'uploaded_file', sourceId, reason: 'missing-original' }));
  const approval = { runId: verified.runId, snapshotSha256: verified.manifestSha256, missing };
  const original = activationExpectation(verified, missing, verified.manifestSha256, approval);
  const reordered = activationExpectation(verified, missing, verified.manifestSha256, { ...approval, missing: [...missing].reverse() });
  assertActivationRetry(original, reordered);
  assert.throws(() => assertActivationRetry(original, { ...reordered, generationId: randomUUID() }), refuses('approval-invalid'));
  assert.throws(() => parseMigrationApproval('{"runId":"x","r\\u0075nId":"y"}'), refuses('approval-invalid'));
  assert.throws(() => parseMigrationApproval('{"missing":[{"type":"uploaded_file","type":"attachment"}]}'), refuses('approval-invalid'));
  assert.throws(() => activationExpectation(verified, [], verified.manifestSha256, { ...approval, missing: [] }), refuses('approval-invalid'));
  assert.equal(activationExpectation(verified, [], verified.manifestSha256).approvalSha256, null);
});

test('verified PLANKA directory and object media stage exact bytes and independent references behind the generation fence',
  { timeout: 150_000, skip: !mediaDecoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async (t) => {
    const root = await mkdtemp(join(homedir(), '.planner-migration-media-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const postgres = await startFixturePostgres(t, root);
    postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
    const local = await configureSource(root, postgres, '2.3.0');
    const objectFiles = await configureSource(root, postgres, '2.3.1');
    const objects = await frozenObjects(t, objectFiles, root);
    local.update(await readFile(new URL('../fixtures/planka/unsupported-link.sql', import.meta.url), 'utf8'));
    const originalKey = 'private/attachments/9007199254741220/Re\u0301seau Tile.png';
    const derivativeKey = 'private/attachments/9007199254741220/thumbnails/outside-720.png';
    const wrongKey = join(local.input.assetsRoot, originalKey.replace('Re\u0301seau', 're\u0301seau'));
    const originalFile = join(local.input.assetsRoot, originalKey);
    const bytes = await readFile(originalFile);
    const digest = sha256(bytes);
    await rename(originalFile, wrongKey);
    await assert.rejects(inspect(local), refuses('asset-key'));
    await rename(wrongKey, originalFile);
    await assert.rejects(withMigrationSnapshot(local.input, owner, local.config, undefined, {}, async (snapshot) => {
      const corrupt = Buffer.from(bytes);
      corrupt[corrupt.length - 1] ^= 0xff;
      await writeFile(originalFile, corrupt);
      try {
        await snapshot.readAsset(originalKey, new AbortController().signal, async (input) => {
          for await (const _chunk of input) { /* The same-length mutation must fail the streaming checksum. */ }
        });
      } finally { await writeFile(originalFile, bytes); }
    }), refuses('asset-integrity'));
    objects.missing.add(derivativeKey);
    const localReceipt = await inspect(local);
    const objectReceipt = await inspect(objects);
    assert.deepEqual(objectReceipt.assets, { present: 8, missingOriginals: 0, missingDerivatives: 1 });
    const decode = createMediaDecoder(fileURLToPath(new URL('../../ops/package/decode-media.py', import.meta.url)), mediaPython);
    await withFixtureMongo((fixture) => loadTarget(fixture, async (target) => {
      const { db, lease, cursors, installationId, activeGenerationId } = target;
      const staging = join(fixture.directory, 'staging');
      const blobs = join(fixture.directory, 'blobs');
      await mkdir(staging, { mode: 0o700 });
      await mkdir(blobs, { mode: 0o700 });
      let store = await createPrivateMediaStore(staging, blobs);
      t.after(() => store.close());
      const stage = (source, identity, mediaStore = store, database = db, cursorSet = cursors) => withMigrationSnapshot(source.input, owner,
        source.config, source.objectConfig, { expectedFingerprint: identity.fingerprint.sha256 }, (snapshot) =>
          stageMigrationWorkspace(database, lease, identity, snapshot, cursorSet, { store: mediaStore, decode }, 1)).then(({ value }) => value);
      const verify = async (source, identity, cursorSet = cursors) => {
        const run = await db.collection('importRuns').findOne(importRunKey(identity));
        return (await withMigrationSnapshot(source.input, owner, source.config, source.objectConfig,
          { expectedFingerprint: identity.fingerprint.sha256 }, async (snapshot) => {
            await beginMigrationVerification(lease, db, run, snapshot, cursorSet);
            return collectMigrationVerification(db, lease, identity, snapshot, cursorSet,
              { verifyBlob: store.verifyBlob, scratch: store, decode }, new AbortController().signal);
          })).value;
      };
      const localRun = await createRun(db, installationId, localReceipt);
      const localId = publicIds(localReceipt.capture.source.instanceId);
      const scoped = { generationId: localRun.generationId };
      const saved = () => db.collection('importRuns').findOne(importRunKey(localRun));
      await assert.rejects(verify(local, localRun), refuses('verification-incomplete'));
      await assert.rejects(stage(local, localRun, interruptMediaStore(store, 'staged')), refuses('target-write'));
      const beforeMedia = (await saved()).checkpoint;
      assert.equal(beforeMedia.pass, 'projections');
      assert.equal((await readdir(staging)).length, 1);
      assert.deepEqual(await readdir(blobs), []);
      await store.close();
      store = await createPrivateMediaStore(staging, blobs);
      await assert.rejects(stage(local, localRun, interruptMediaStore(store, 'published')), refuses('target-write'));
      assert.deepEqual((await saved()).checkpoint, beforeMedia);
      assert.equal((await readdir(staging)).length, 2);
      assert.deepEqual(await readdir(blobs), [digest]);
      assert.deepEqual(await readFile(join(blobs, digest)), bytes);
      assert.equal(await db.collection('attachments').countDocuments(scoped), 0);
      await store.close();
      store = await createPrivateMediaStore(staging, blobs);
      await assert.rejects(stage(local, localRun, store, interruptCheckpoint(db, 'media', 'attachment')), refuses('target-write'));
      assert.deepEqual((await saved()).checkpoint, beforeMedia);
      assert.equal(await db.collection('attachments').countDocuments(scoped), 1);
      await assert.rejects(stage(local, localRun, store, interruptCheckpoint(db, 'media', 'user_account', 1)), refuses('target-write'));
      assert.equal((await saved()).checkpoint.table, 'user_account');
      await assert.rejects(verify(local, localRun), refuses('verification-incomplete'));
      assert.equal((await saved()).state, 'staging');
      const checkpoint = await stage(local, localRun);
      assert.equal(checkpoint.pass, 'media');
      assert.equal(checkpoint.table, 'user_account');
      assert.deepEqual(await stage(local, localRun), checkpoint);
      await store.sweepStages(128, Date.now() + 1000);
      assert.deepEqual(await readdir(staging), []);
      const counts = { attachments: 7, projectBackgrounds: 1, blobs: 4, events: 0, commands: 0, sessions: 0 };
      for (const [collection, count] of Object.entries(counts)) assert.equal(await db.collection(collection).countDocuments(scoped), count, collection);
      const files = mediaRecords(db, localRun.generationId);
      const image = await files.attachment(localId('attachment', '601'));
      const shared = await files.attachment(localId('attachment', '602'));
      assert.notEqual(image.id, shared.id);
      assert.notEqual(image.cardId, shared.cardId);
      assert.deepEqual([image.name, shared.name], ['Cover study', 'Same stored study']);
      assert.deepEqual([image.blobDigest, shared.blobDigest, image.byteLength], [digest, digest, bytes.length]);
      assert.equal((await files.attachment(localId('attachment', '603'))).blobDigest,
        (await files.attachment(localId('attachment', '604'))).blobDigest);
      const variants = catalogVariants(await files.catalog(digest));
      await Promise.all(Object.values(variants).map((variant) => store.verifyBlob(variant)));
      const cover = await readsFor(db, localRun.generationId, localId, '103', 'boardUser').cardGet({ id: image.cardId });
      assert.equal(cover.data.coverAttachmentId, image.id);
      assert.equal(cover.data.attachments.find(({ id }) => id === image.id).hasThumbnail, true);
      const secondCard = await readsFor(db, localRun.generationId, localId, '103', 'boardUser').cardGet({ id: shared.cardId });
      const inert = secondCard.data.attachments.find(({ id }) => id === localId('attachment', '607'));
      assert.deepEqual([inert.kind, inert.url, inert.available], ['link', null, false]);
      assert.equal((await files.attachment(localId('attachment', '606'))).url, 'http://127.0.0.1/fixture-only');
      for (const [entity, sourceId, expectedLength] of [['user_account', '102', '311'], ['background_image', '211', '419']]) {
        const { provenance: { media } } = await db.collection('importIds').findOne({ ...scoped, entity, sourceId });
        assert.equal(media.sourceSize, expectedLength);
        assert.notEqual(String(media.original.byteLength), expectedLength);
        const blob = await files.catalog(media.original.sha256);
        assert.equal(blob.byteLength, media.original.byteLength);
        const identity = entity === 'user_account' ? (await files.avatar(localId(entity, sourceId))).avatarMedia
          : await files.background(localId(entity, sourceId));
        assert.equal(identity.byteLength, media.original.byteLength);
      }
      const userView = await openActiveWorkspace(db, installationId);
      assert.equal(userView.generationId, activeGenerationId);
      assert.equal(await userView.read('attachments', image.id), null);
      assert.deepEqual(await readFile(originalFile), bytes);
      const verifiedLocal = await verify(local, localRun);
      assert.equal(verifiedLocal.summary.outcome, 'verified', JSON.stringify(verifiedLocal.summary));
      assert.equal(verifiedLocal.summary.assets.missingOriginals, 0);
      assert.equal(verifiedLocal.summary.scopedReads.boardReads, 2);
      assert.ok(verifiedLocal.summary.scopedReads.deniedReads > 0);
      assert.equal(verifiedLocal.summary.reasons['stale-previous-list'], 1);
      assert.equal(verifiedLocal.summary.tables.notification.quarantined, '1');

      const objectRun = await createRun(db, installationId, objectReceipt);
      const objectId = publicIds(objectReceipt.capture.source.instanceId);
      await assert.rejects(withMigrationSnapshot(objects.input, owner, objects.config, objects.objectConfig, {}, async (snapshot) => {
        objects.mismatched.add(originalKey);
        try { await snapshot.readAsset(originalKey, new AbortController().signal, async () => {}); }
        finally { objects.mismatched.delete(originalKey); }
      }), refuses('asset-integrity'));
      const requestStart = objects.requests.length;
      await stage(objects, objectRun);
      const encoded = '/frozen/' + originalKey.split('/').map(encodeURIComponent).join('/');
      assert.equal(objects.requests.slice(requestStart).filter(({ path, version }) =>
        path === encoded && version === objects.versions.get(originalKey)).length, 3);
      const objectMedia = mediaRecords(db, objectRun.generationId);
      const objectImage = await objectMedia.attachment(objectId('attachment', '601'));
      assert.equal(objectImage.blobDigest, sha256(await readFile(join(objectFiles.input.assetsRoot, originalKey))));
      const generated = catalogVariants(await objectMedia.catalog(objectImage.blobDigest));
      await Promise.all(Object.values(generated).map((variant) => store.verifyBlob(variant)));

      objects.missing.add(originalKey);
      const absentReceipt = await inspect(objects);
      assert.equal(absentReceipt.assets.missingOriginals, 1);
      const statePath = join(root, 'reports');
      await mkdir(statePath, { mode: 0o700 });
      const directory = await open(statePath);
      t.after(() => directory.close());
      const capacity = { mongoBytes: '1', blobBytes: '1', stagingBytes: '1' };
      const savePreflight = () => persistMigrationPreflight(lease, db, installationId, directory, owner, objects.input, absentReceipt, capacity);
      const preflight = await savePreflight();
      const load = () => readProtectedMigrationRun(db, installationId, directory, owner, preflight.runId);
      const { run: initial, cursors: absentCursors } = await load();
      const absentRun = { runId: initial.id, generationId: initial.generationId, installationId, fingerprint: initial.fingerprint };
      await stage(objects, absentRun, store, db, absentCursors);
      const absent = mediaRecords(db, absentRun.generationId);
      for (const sourceId of ['601', '602']) {
        const row = await absent.attachment(objectId('attachment', sourceId));
        assert.deepEqual([row.availability, row.blobDigest, row.byteLength], ['unavailable', null, undefined]);
      }
      const unavailable = await readsFor(db, absentRun.generationId, objectId, '103', 'boardUser').cardGet({ id: objectImage.cardId });
      assert.equal(unavailable.data.coverAttachmentId, objectImage.id);
      assert.equal(unavailable.data.attachments.find(({ id }) => id === objectImage.id).available, false);
      assert.equal(await absent.catalog(objectImage.blobDigest), null);

      const evidence = await verify(objects, absentRun, absentCursors);
      assert.deepEqual(await savePreflight(), preflight);
      assert.equal((await load()).run.state, 'verifying');
      assert.equal(evidence.summary.outcome, 'verified', JSON.stringify(evidence.summary));
      assert.equal(evidence.summary.eligibleUnderDefaultPolicy, false);
      assert.equal(evidence.summary.assets.missingOriginals, 1);
      assert.equal(evidence.summary.assets.missingDerivatives, 1);
      assert.equal(evidence.summary.tables.attachment.unavailable, '2');
      assert.equal(evidence.summary.tables.uploaded_file.unavailable, '1');
      for (const { input, ...counts } of Object.values(evidence.summary.tables)) {
        assert.equal(BigInt(input), Object.values(counts).reduce((total, count) => total + BigInt(count), 0n));
      }
      assert.deepEqual(evidence.missing, [{ type: 'uploaded_file', sourceId: '9007199254741220', reason: 'missing-original' }]);
      assert.equal(JSON.stringify(publicMigrationVerification(evidence)).includes('9007199254741220'), false);
      const page = migrationVerificationPage(evidence, 0, 1);
      assert.equal(page.details.length, 1);
      assert.equal(page.nextOffset, 1);

      {
        const run = await db.collection('importRuns').findOne(importRunKey(absentRun));
        const interrupted = new Error('simulated crash before the verification CAS');
        await assert.rejects(persistMigrationVerification(lease, db, directory, owner, run, evidence, async () => { throw interrupted; }),
          (error) => error === interrupted);
        const retry = await db.collection('importRuns').findOne(importRunKey(absentRun));
        assert.equal(retry.state, 'verifying');
        assert.deepEqual(retry.verificationStartedAt, run.verificationStartedAt);
        assert.equal((await verify(objects, absentRun, absentCursors)).reportSha256, evidence.reportSha256);
        await assert.rejects(readMigrationVerification(directory, owner, run), refuses('verification-incomplete'));
        await persistMigrationVerification(lease, db, directory, owner, run, evidence);
        const verified = await db.collection('importRuns').findOne(importRunKey(absentRun));
        const savedReport = await readMigrationVerification(directory, owner, verified);
        assert.equal(savedReport.reportSha256, evidence.reportSha256);
        assert.deepEqual(await savePreflight(), preflight);
        assert.equal((await load()).run.state, 'verified');
        await assert.rejects(prepareMigrationActivation(directory, owner, verified, run.manifestSha256), refuses('approval-required'));
        const approvalPath = join(statePath, 'approval.json');
        const approval = { runId: run.id, snapshotSha256: run.manifestSha256, missing: evidence.missing };
        const activate = (expectedManifest = run.manifestSha256) => prepareMigrationActivation(directory, owner, verified, expectedManifest, approvalPath);
        for (const bad of [{ ...approval, runId: randomUUID() }, { ...approval, snapshotSha256: '0'.repeat(64) },
          { ...approval, missing: [...approval.missing, ...approval.missing] }, { ...approval, missing: [] },
          { ...approval, missing: [{ ...approval.missing[0], reason: 'corrupt-original' }] }]) {
          await writeFile(approvalPath, JSON.stringify(bad), { mode: 0o600 });
          await assert.rejects(activate(), refuses('approval-invalid'));
        }
        await writeFile(approvalPath, JSON.stringify(approval), { mode: 0o600 });
        await assert.rejects(activate('0'.repeat(64)), refuses('approval-invalid'));
        const expectation = await activate();
        assert.equal(expectation.reportSha256, evidence.reportSha256);
        assert.equal(expectation.missingOriginals, 1);
        await writeFile(approvalPath, JSON.stringify({ missing: approval.missing, snapshotSha256: run.manifestSha256, runId: run.id }, null, 2));
        assertActivationRetry(expectation, await activate());
        assert.throws(() => assertActivationRetry(expectation, { ...expectation, approvalSha256: '1'.repeat(64) }), refuses('approval-invalid'));
        assert.equal((await openActiveWorkspace(db, installationId)).generationId, activeGenerationId);
      }

      const changed = Buffer.from(bytes);
      changed[0] ^= 0xff;
      await chmod(join(blobs, digest), 0o600);
      await writeFile(join(blobs, digest), changed);
      await chmod(join(blobs, digest), 0o400);
      try {
        const blocked = await verify(local, localRun);
        assert.equal(blocked.summary.outcome, 'blocked');
        assert.equal(blocked.summary.reasons['storage-media'], 2);
        assert.equal(blocked.summary.eligibleUnderDefaultPolicy, false);
      } finally {
        await chmod(join(blobs, digest), 0o600);
        await writeFile(join(blobs, digest), bytes);
        await chmod(join(blobs, digest), 0o400);
      }

      const catalog = db.collection('blobs');
      const catalogMatch = { ...scoped, digest };
      const originalCatalog = await catalog.findOne(catalogMatch);
      await catalog.updateOne(catalogMatch, { $set: { mimeType: 'application/octet-stream', variants: null } });
      const downgraded = await verify(local, localRun);
      assert.equal(downgraded.summary.outcome, 'blocked');
      assert.equal(downgraded.summary.reasons['storage-media'], 2);
      const otherImage = await catalog.findOne({ ...scoped, mimeType: 'image/png', digest: { $ne: digest } });
      await catalog.updateOne(catalogMatch, { $set: { mimeType: originalCatalog.mimeType, variants: otherImage.variants } });
      const swapped = await verify(local, localRun);
      assert.equal(swapped.summary.outcome, 'blocked');
      assert.equal(swapped.summary.reasons['storage-media'], 2);
      await catalog.replaceOne(catalogMatch, originalCatalog);

      const ids = db.collection('importIds');
      await ids.updateOne({ ...scoped, entity: 'action', sourceId: '711' }, { $set: { 'provenance.discussion.decoded.snapshot.fromList': null } });
      await ids.updateOne({ ...scoped, entity: 'attachment', sourceId: '601' }, { $set: { 'provenance.media.derivatives': null } });
      const existingBoard = await ids.findOne({ ...scoped, entity: 'board', sourceId: '301' });
      const extraId = localId('board', '9999');
      await ids.insertOne({ ...existingBoard, _id: workspaceKey(localRun.generationId, extraId), id: extraId, sourceId: '9999' });
      const damaged = await verify(local, localRun);
      assert.equal(damaged.summary.outcome, 'blocked');
      assert.equal(damaged.summary.tables.action.blocked, '1');
      assert.equal(damaged.summary.tables.attachment.blocked, '1');
      assert.ok(damaged.summary.problems.some(({ type, entity }) => type === 'staged-count' && entity === 'importIds'));

      local.update(`INSERT INTO public.attachment (id, card_id, creator_user_id, type, data, name)
        SELECT 608, card_id, creator_user_id, type, jsonb_set(data, '{filename}', '"Alternate Study.png"'), 'Conflicting original'
        FROM public.attachment WHERE id = 601;`);
      const ambiguousReceipt = await inspect(local);
      assert.equal(ambiguousReceipt.assets.missingOriginals, 1);
      const ambiguousRun = await createRun(db, installationId, ambiguousReceipt);
      await stage(local, ambiguousRun);
      const ambiguous = await verify(local, ambiguousRun);
      assert.equal(ambiguous.summary.outcome, 'blocked');
      assert.equal(ambiguous.summary.assets.missingOriginals, 1);
      assert.equal(ambiguous.summary.reasons['ambiguous-original'], 1);
      assert.equal(ambiguous.summary.tables.uploaded_file.blocked, '1');
      assert.deepEqual(ambiguous.missing, []);
      const availableBytes = await readFile(join(objectFiles.input.assetsRoot, 'private/attachments/9007199254741221/Fixture Deck.txt'));
      await assertApprovedUnavailableMedia(db, installationId, absentRun.generationId, objectId, store, decode, availableBytes);
    }));
  });

async function killMigrationAt(fixture, options) {
  const child = fork(fileURLToPath(new URL('../support/migration-replay-crash.mjs', import.meta.url)), [], {
    execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const { username, password } = fixture.client.options.credentials;
  try {
    await new Promise((resolve, reject) => {
      let reported;
      child.once('error', reject);
      child.once('message', (point) => { reported = point; child.kill('SIGKILL'); });
      child.once('exit', (code, signal) => {
        if (signal === 'SIGKILL' && reported === options.point) resolve();
        else reject(new Error(`Owned migration child did not reach ${options.point} (${code ?? signal}).`));
      });
      child.send({ ...options, socketPath: fixture.socketPath, database: fixture.db.databaseName, auth: { username, password } });
    });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

test('native migration replay survives SIGKILL before the stage checkpoint and after the activation CAS',
  { timeout: 100_000, skip: !mediaDecoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async (t) => {
    const root = await mkdtemp(join(homedir(), '.planner-migration-replay-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const postgres = await startFixturePostgres(t, root);
    postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
    const source = await configureSource(root, postgres, '2.3.0');
    await unlink(join(source.input.assetsRoot, 'private/attachments/9007199254741220/Re\u0301seau Tile.png'));
    const receipt = await inspect(source);
    await withFixtureMongo((fixture) => loadTarget(fixture, async ({ db, installationId, lease }) => {
      const writer = join(fixture.directory, 'writer');
      const staging = join(fixture.directory, 'staging');
      const blobs = join(fixture.directory, 'blobs');
      const receipts = join(root, 'receipts');
      for (const dir of [staging, blobs, receipts]) await mkdir(dir, { mode: 0o700 });
      const state = db.collection('installation');
      await state.updateOne({ _id: 'installation' }, { $set: { activeGenerationId: null } });
      const directory = await open(receipts);
      const store = await createPrivateMediaStore(staging, blobs);
      const decode = createMediaDecoder(fileURLToPath(new URL('../../ops/package/decode-media.py', import.meta.url)), mediaPython);
      const capacity = { mongoBytes: '1', blobBytes: '1', stagingBytes: '1' };
      let owned = lease;
      try {
        const { runId } = await persistMigrationPreflight(owned, db, installationId, directory, owner, source.input, receipt, capacity);
        const reread = () => readProtectedMigrationRun(db, installationId, directory, owner, runId);
        const saved = await reread();
        const generationId = saved.run.generationId;
        const scoped = { generationId };
        const args = { writer, receipts, runId, installationId, staging, blobs, source: source.config };
        const before = publicMigrationStatus(saved.run);
        assert.equal(before.state, 'preflighted');
        assert.equal(before.stageComplete, false);
        owned.release();
        await killMigrationAt(fixture, { ...args, point: 'before-checkpoint' });
        assert.equal(await db.collection('importIds').countDocuments(scoped), 1);
        assert.deepEqual(publicMigrationStatus((await reread()).run), before);
        assert.equal((await state.findOne({ _id: 'installation' })).activeGenerationId, null);
        owned = acquireWriterDirectory(writer, owner, owner);
        const stage = (current = saved) => stageProtectedMigrationRun(db, owned, current, owner, source.config,
          undefined, { store, decode }, 2);
        const raw = await readFile(source.input.manifest);
        await writeFile(source.input.manifest, Buffer.concat([raw, Buffer.from('\n')]));
        await assert.rejects(stage(), refuses('source-changed'));
        assert.equal(await db.collection('importIds').countDocuments(scoped), 1);
        assert.deepEqual(publicMigrationStatus((await reread()).run), before);
        await writeFile(source.input.manifest, raw);
        const complete = await stage();
        assert.equal(complete.stageComplete, true);
        assert.equal(complete.checkpoint.table, 'user_account');
        assert.deepEqual(await stage(await reread()), complete);
        assert.equal(await db.collection('attachments').countDocuments(scoped), 6);
        assert.equal(await db.collection('events').countDocuments(scoped), 0);
        assert.equal((await persistMigrationPreflight(owned, db, installationId, directory, owner, source.input, receipt, capacity)).runId, runId);

        const identity = { runId, generationId, installationId, fingerprint: receipt.fingerprint };
        const { run, cursors } = await reread();
        const verify = (current) => withMigrationSnapshot(source.input, owner, source.config, undefined, {}, async (snapshot) => {
          const verifying = await beginMigrationVerification(owned, db, current, snapshot, cursors);
          const report = await collectMigrationVerification(db, owned, identity, snapshot, cursors,
            { verifyBlob: store.verifyBlob, scratch: store, decode }, new AbortController().signal);
          return persistMigrationVerification(owned, db, directory, owner, verifying, report);
        });
        await assert.rejects(verify({ ...run, stageCompletion: undefined }), refuses('verification-incomplete'));
        const mfaKey = randomBytes(32);
        const administrator = { userId: publicIds(receipt.capture.source.instanceId)('user_account', '101'),
          revision: 3, credentialsVersion: 3, factorId: randomUUID() };
        const prior = { generationId: null, setup: (await state.findOne({ _id: 'installation' })).setup };
        const verification = { runId, generationId, manifestSha256: receipt.manifestSha256, fingerprintSha256: receipt.fingerprint.sha256,
          reportSha256: '0'.repeat(64), missingOriginals: 0, approvalSha256: null };
        const request = { verification, administrator, prior, mfaKeyDigest: sha256(mfaKey), approval: undefined };
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, request), refuses('activation-conflict'));
        const { value: report } = await verify(run);
        assert.equal(report.summary.outcome, 'verified');
        const approvalPath = join(receipts, 'approval.json');
        request.approval = { runId, snapshotSha256: receipt.manifestSha256, missing: report.missing };
        await writeFile(approvalPath, JSON.stringify(request.approval), { mode: 0o600 });
        request.verification = await prepareMigrationActivation(directory, owner, (await reread()).run, receipt.manifestSha256, approvalPath);
        await state.updateOne({ _id: 'installation' }, { $set: { mfaKeyDigest: request.mfaKeyDigest } });
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, request), refuses('activation-conflict'));
        const verifiedRun = (await reread()).run;
        const issued = await issueMigrationAdminRecovery(db, owned, verifiedRun, { runId, sourceUserId: '101', rotate: false });
        assert.equal(issued.userId, administrator.userId);
        const gate = { runCommand: (operation) => { owned.assertHeld(); return operation(); } };
        const hasher = createPasswordHasher();
        const recovery = await consumeMigrationAdminRecovery(db, installationId, gate, hasher, {
          grant: issued.grant, password: 'synthetic replay fixture',
        });
        assert.equal(recovery.status, 'enrollment-required');
        assert.equal(await readMigrationAdminActivationProof(db, verifiedRun), null);
        const mfa = createMfaManagement(db, installationId, gate, createSecretKey(mfaKey), hasher);
        const secret = await mfa.begin({ enrollmentId: recovery.enrollmentId });
        const totp = new TOTP({ secret: Secret.fromBase32(secret.secret), algorithm: 'SHA1', digits: 6, period: 30 });
        const factors = await mfa.confirm({ enrollmentId: recovery.enrollmentId }, totp.generate());
        assert.equal(factors.recoveryCodes.length, 10);
        const proof = await readMigrationAdminActivationProof(db, verifiedRun);
        assert.equal(proof.userId, administrator.userId);
        request.administrator = { userId: proof.userId, revision: proof.accountRevision, credentialsVersion: proof.credentialsVersion,
          factorId: proof.factorId, recoveryId: proof.recoveryId };
        request.prior = { generationId: null, setup: (await state.findOne({ _id: 'installation' })).setup };
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, { ...request,
          administrator: { ...request.administrator, recoveryId: randomUUID() } }), refuses('activation-conflict'));
        mfaKey.fill(0);
        const wrongApproval = { ...request, verification: { ...request.verification, approvalSha256: 'a'.repeat(64) } };
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, wrongApproval), refuses('approval-invalid'));
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, { ...request, approval: undefined }), refuses('approval-required'));
        const wrongFingerprint = { ...request, verification: { ...request.verification, fingerprintSha256: '0'.repeat(64) } };
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, wrongFingerprint), refuses('activation-conflict'));
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, { ...request,
          prior: { ...request.prior, generationId: randomUUID() } }), refuses('activation-conflict'));
        assert.equal((await state.findOne({ _id: 'installation' })).activeGenerationId, null);
        owned.release();
        await killMigrationAt(fixture, { ...args, point: 'activation', activation: request });
        const published = await state.findOne({ _id: 'installation' });
        assert.equal(published.activeGenerationId, generationId);
        assert.equal(published.migrationActivation.state, 'activeReadOnly');
        assert.equal(published.setup.migrationAdminRecovery, undefined);
        owned = acquireWriterDirectory(writer, owner, owner);
        const replay = await activateVerifiedMigration(db, owned, installationId, cursors, request);
        assert.deepEqual(replay, published.migrationActivation);
        await assert.rejects(activateVerifiedMigration(db, owned, installationId, cursors, { ...request, mfaKeyDigest: 'a'.repeat(64) }), refuses('activation-conflict'));
        assert.deepEqual(await state.findOne({ _id: 'installation' }), published);
        assert.equal(await db.collection('attachments').countDocuments(scoped), 6);
        assert.equal(await db.collection('events').countDocuments(scoped), 0);
        assert.deepEqual(await readFile(source.input.manifest), raw);
      } finally { owned.release(); await store.close(); await directory.close(); }
    }));
  });


test('both frozen PLANKA pins reconcile independently counted clean, inconsistent and ambiguous fixtures',
  { timeout: 150_000, skip: !mediaDecoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async (t) => {
    const root = await mkdtemp(join(homedir(), '.planner-migration-matrix-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const postgres = await startFixturePostgres(t, root);
    postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT');
    const decode = createMediaDecoder(fileURLToPath(new URL('../../ops/package/decode-media.py', import.meta.url)), mediaPython);
    await withFixtureMongo((fixture) => loadTarget(fixture, async ({ db, lease, cursors, installationId }) => {
      const staging = join(fixture.directory, 'staging');
      const blobs = join(fixture.directory, 'blobs');
      await mkdir(staging, { mode: 0o700 });
      await mkdir(blobs, { mode: 0o700 });
      const store = await createPrivateMediaStore(staging, blobs);
      try {
        for (const release of ['2.3.0', '2.3.1']) {
          for (const scenario of ['clean', 'inconsistent', 'ambiguous']) {
            const files = await configureSource(root, postgres, release, scenario);
            const object = (release === '2.3.1' && scenario === 'clean')
              || (release === '2.3.0' && scenario === 'inconsistent');
            const source = object ? await frozenObjects(t, files, root) : files;
            if (scenario === 'inconsistent') {
              if (object) source.missing.add(sharedImageKey);
              else await unlink(join(files.input.assetsRoot, sharedImageKey));
            }
            const receipt = await inspect(source);
            const identity = await createRun(db, installationId, receipt);
            await withMigrationSnapshot(source.input, owner, source.config, source.objectConfig,
              { expectedFingerprint: identity.fingerprint.sha256 }, (snapshot) =>
                stageMigrationWorkspace(db, lease, identity, snapshot, cursors, { store, decode }, 4));
            const run = await db.collection('importRuns').findOne(importRunKey(identity));
            const { value: report } = await withMigrationSnapshot(source.input, owner, source.config, source.objectConfig,
              { expectedFingerprint: identity.fingerprint.sha256 }, async (snapshot) => {
                await beginMigrationVerification(lease, db, run, snapshot, cursors);
                return collectMigrationVerification(db, lease, identity, snapshot, cursors,
                  { verifyBlob: store.verifyBlob, scratch: store, decode }, new AbortController().signal);
              });
            assertReport(publicMigrationVerification(report), report.details, scenario);
            assert.equal(report.missing.length, Number(scenario === 'inconsistent'));
          }
        }
      } finally { await store.close(); }
    }));
  });
