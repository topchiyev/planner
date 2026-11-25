import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mediaOperations, relationshipCommands, relationshipParentRevisionHeader } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { createPlannerMcpHandler } from '../../apps/backend/dist/application/mcp/http.js';
import { mcpMutationCatalog, mcpMutationWireSchema } from '../../apps/backend/dist/application/mcp/mutation-catalog.js';
import { executeMcpMutation, mcpMutationError } from '../../apps/backend/dist/application/mcp/mutations.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { createRelationshipJournalOperations } from '../../apps/backend/dist/application/workspace/relationship-commands.js';
import { createMediaService } from '../../apps/backend/dist/application/media/service.js';
import { workspaceCollections } from '../../apps/backend/dist/storage/catalog.js';
import { resolveBrowserWorkspace } from '../../apps/backend/dist/application/workspace/authorization.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';

const parentProject = ids.privateProject;
const sharedProject = ids.sharedProject;
const board = ids.privateBoard;
const active = ids.privateActiveList;
const closed = ids.privateClosedList;
const card = ids.activeCard;
const checklist = ids.checklist;
const group = ids.fieldGroup;
const field = ids.fieldDefinition;
const [ordinaryTask, nextChecklist, comment, notice, localTemplate, linkedGroup, templateField, label, file, background, siblingBoard] =
  Array.from({ length: 11 }, (_, i) => fixtureId(5000 + i));
const target = (id, rest = {}) => ({ id, expectedRevision: 1, ...rest });
const order = { sourceOrderVersion: 1, destinationOrderVersion: 1 };
const fieldValue = target(card, { groupId: group, fieldId: field, groupRevision: 1, definitionRevision: 1 });
const actor = ids.privateOwner;
const cases = {
  checklist_create: target(card, { name: 'New checklist' }),
  checklist_update: target(checklist, { name: 'Updated checklist' }),
  checklist_delete: target(checklist),
  task_create: target(checklist, { name: 'New task' }),
  task_update: target(ordinaryTask, { completed: true }),
  task_move: target(ordinaryTask, { toChecklistId: nextChecklist, beforeTaskId: null, ...order }),
  task_delete: target(ordinaryTask),
  comment_create: target(card, { text: 'New comment for @[Editor](' + ids.firstEditor + ')' }),
  comment_update: target(comment, { text: 'Updated comment' }),
  comment_delete: target(comment),
  notification_update: target(notice, { expectedRevision: 0, read: true }),
  notification_read_all: {},
  notification_read_card: { id: card },
  field_create_template: target(parentProject, { name: 'New template' }),
  field_create_group: target(board, { scopeType: 'board', name: 'New local group' }),
  field_update_group: target(group, { name: 'Updated group' }),
  field_delete_group: target(group, { confirm: true }),
  field_detach_group: target(linkedGroup),
  field_promote_group: target(group, { projectRevision: 1 }),
  field_create: target(group, { name: 'New field' }),
  field_update: target(field, { groupId: group, name: 'Updated field' }),
  field_delete: target(field, { groupId: group }),
  field_set_value: { ...fieldValue, value: '  exact replacement  ' },
  field_clear_value: fieldValue,
  label_create: target(board, { name: 'New label', color: 'lagoon-blue' }),
  label_update: target(label, { name: 'Updated label' }),
  label_delete: target(label),
  card_add_label: target(card, { relatedId: label }),
  card_remove_label: target(card, { relatedId: label }),
  card_assign: target(card, { relatedId: ids.viewer }),
  card_unassign: target(card, { relatedId: ids.secondEditor }),
  board_follow: target(board),
  board_unfollow: target(board),
  card_follow: target(card),
  card_unfollow: target(card),
  list_sort: target(active, { field: 'name', direction: 'asc', sourceOrderVersion: 1 }),
  list_archive_cards: target(closed, { archiveListId: ids.privateArchive, ...order }),
  card_create: target(active, { name: 'New card' }),
  card_duplicate: target(card, { toListId: closed, beforeCardId: null, ...order }),
  card_update: target(card, { name: 'Updated card' }),
  card_move: target(card, { toListId: closed, beforeCardId: null, ...order }),
  card_archive: target(card, order),
  card_trash: target(card, order),
  card_restore: target(ids.archivedStory, { toListId: closed, beforeCardId: null, ...order }),
  list_delete: target(closed, { sourceOrderVersion: 1, trashOrderVersion: 1, boardOrderVersion: 1 }),
  board_create: target(parentProject, { name: 'New board' }),
  board_move: target(siblingBoard, { beforeBoardId: board, projectBoardOrderVersion: 1 }),
  board_update: target(board, { name: 'Updated board' }),
  list_create: target(board, { name: 'New list', kind: 'active' }),
  list_update: target(closed, { name: 'Updated list' }),
  list_move: target(closed, { toBoardId: board, beforeListId: active, ...order }),
  project_create: { name: 'New project', type: 'private' },
  project_favorite: target(parentProject),
  project_unfavorite: target(parentProject),
  project_update: target(parentProject, { name: 'Updated project' }),
  project_add_manager: target(sharedProject, { userId: ids.createOnlyOwner }),
  project_remove_manager: target(sharedProject, { userId: ids.projectManager, expectedRevision: 0 }),
  board_add_member: target(board, { userId: ids.unrelated, role: 'viewer', canComment: true }),
  board_update_member: target(board, { userId: ids.viewer, expectedRevision: 0, canComment: true }),
  board_remove_member: target(board, { userId: ids.viewer, expectedRevision: 0 }),
  attachment_add_link: target(card, { name: '  New link  ', url: 'https://fixture.invalid/sample' }),
  attachment_update: target(file, { name: 'Updated attachment' }),
  attachment_delete: target(file),
  project_remove_background: target(parentProject, { backgroundId: background }),
};
const adminOperations = new Set(['project_add_manager', 'project_remove_manager']);

async function seed(f) {
  await f.insert('tasks', ordinaryTask, { checklistId: checklist, name: 'Ordinary task', completed: false, rank: '2048' });
  await f.insert('checklists', nextChecklist, { cardId: card, name: 'Destination list', rank: '2048', orderVersion: 1 });
  await f.insert('comments', comment, { boardId: board, cardId: card, text: 'Earlier comment', authorId: actor });
  await f.insert('notifications', notice, { cardId: card, recipientId: actor, sourceBoardId: board, boardId: board,
    commentId: comment, kind: 'commentCard', actorId: actor, readAt: null });
  await f.insert('fieldGroups', localTemplate, { scopeType: 'project', scopeId: parentProject, name: 'Template', rank: '1024' });
  await f.insert('fieldGroups', linkedGroup, { scopeType: 'board', scopeId: board, templateGroupId: localTemplate, name: null, rank: '2048' });
  await f.insert('fieldDefinitions', templateField, { fieldGroupId: localTemplate, name: 'Inherited field', rank: '1024' });
  await f.insert('labels', label, { boardId: board, name: 'Earlier label', color: 'lagoon-blue', rank: '1024' });
  await f.insert('attachments', file, { cardId: card, name: 'Earlier attachment', kind: 'link', url: 'https://fixture.invalid/prior' });
  await f.insert('projectBackgrounds', background, { projectId: parentProject, name: 'Earlier background', kind: 'file', availability: 'unavailable' });
  await f.insert('boards', siblingBoard, { projectId: parentProject, name: 'Sibling board', rank: '2048', orderVersion: 1 });
  await Promise.all([
    f.db.collection('notifications').updateOne({ ...f.scope, id: notice }, { $unset: { revision: '' } }),
    f.db.collection('boardMembers').updateOne({ ...f.scope, boardId: board, userId: ids.viewer }, { $unset: { revision: '' } }),
    f.db.collection('projectManagers').updateOne({ ...f.scope, id: ids.sharedManager }, { $unset: { revision: '' } }),
  ]);
}

async function caseSetup(f, name) {
  switch (name) {
    case 'list_archive_cards':
      await f.insert('cards', fixtureId(5048), { boardId: board, listId: closed, name: 'Ready to archive',
        kind: 'board', closed: true, rank: '1024', historySequence: '9007199254740993' });
      break;
    case 'project_remove_manager':
      await f.insert('projectManagers', fixtureId(5049), { projectId: sharedProject, userId: ids.privateOwner });
      break;
    case 'card_remove_label':
      await f.insert('cardLabels', fixtureId(5050), { cardId: card, labelId: label });
      break;
    case 'board_unfollow':
      await f.insert('boardFollows', fixtureId(5051), { boardId: board, userId: actor });
      break;
    case 'card_unfollow':
      await f.insert('cardFollows', fixtureId(5052), { cardId: card, userId: actor, isPermanent: true });
      break;
    case 'project_unfavorite':
      await f.insert('projectFavorites', fixtureId(5053), { projectId: parentProject, userId: actor });
      break;
  }
}

function restTarget(entry, value, key, cookie) {
  const operation = entry.kind === 'relationship' ? relationshipCommands[entry.operation] : mediaOperations[entry.operation];
  const route = ('routes' in operation ? operation.routes : [{ path: operation.path, fixed: {} }])
    .find(({ fixed }) => Object.entries(fixed).every(([field, expected]) => value[field] === expected));
  assert.ok(route);
  const { expectedRevision, ...body } = value;
  const path = route.path.replace(/:([a-zA-Z]+)/gu, (_, name) => {
    const field = body[name];
    delete body[name];
    assert.ok(field, name);
    return field;
  });
  for (const field of Object.keys(route.fixed)) delete body[field];
  return { path, options: { method: operation.method, ...(Object.keys(body).length && { body }),
    headers: { Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)), 'Idempotency-Key': key,
      ...(expectedRevision !== undefined && { 'If-Match': `"${expectedRevision}"` }) } },
  status: entry.kind === 'relationship' ? operation.status
    : operation.method === 'DELETE' ? 204 : operation.method === 'POST' ? 201 : 200 };
}

test('the 64 write descriptors run once through MCP and replay the same authorized REST command',
  { timeout: 125000 }, async () => withFixtureMongo(async (mongo) => {
    let media;
    const f = await makeWorkspaceAccessFixture(mongo, { configureMedia(options) {
      // The four commands are metadata-only. Any use of physical storage fails this drill.
      media = createMediaService(options.db, options.installationId, options.gate, {}, async () => {
        throw new Error('Metadata writes do not decode bytes.');
      }, { now: options.now });
      return (operation) => operation(media);
    } });
    const deny = createPlannerMcpHandler(origin, async () => ({ scopes: ['planner:read'] }));
    try {
      assert.equal(mcpMutationCatalog.length, 64);
      assert.deepEqual(mcpMutationCatalog.map(({ name }) => name).sort(), Object.keys(cases).sort());
      await seed(f);
      const sources = await Promise.all([actor, ids.admin].map(async (userId) => [userId, cookieOf(await f.login(userId))]));
      const cookies = new Map(sources);
      const mutable = workspaceCollections.filter((name) => !['sessions', 'trustedDevices', 'users', 'importRuns'].includes(name));
      const snapshot = () => Promise.all(mutable.map(async (name) =>
        [name, await f.db.collection(name).find(f.scope, { promoteLongs: false, sort: { _id: 1 } }).toArray()]));
      const baseline = await snapshot();
      async function restore() {
        await f.db.client.bulkWrite(baseline.flatMap(([name, rows]) => {
          const namespace = f.db.databaseName + '.' + name;
          return [{ name: 'deleteMany', namespace, filter: f.scope },
            ...rows.map((document) => ({ name: 'insertOne', namespace, document }))];
        }), { ordered: true });
      }

      async function effectSummary(command) {
        const [audit, events, activities, notifications] = await Promise.all(['auditEntries', 'events', 'activities', 'notifications']
          .map((name) => f.db.collection(name).find({ ...f.scope, commandId: command.id }).toArray()));
        assert.equal(audit.length, 1);
        const generatedBoard = command.operationId === 'boards.create' ? audit[0].resourceId : null;
        return {
          effectCount: command.manifest.reduce((count, batch) => count + batch.count, 0),
          audit: [audit[0].action, audit[0].resourceType, audit[0].actorId],
          events: events.map(({ boardId, kind }) => [boardId === generatedBoard ? 'created-board' : boardId, kind]).sort(),
          activities: activities.map(({ boardId, kind }) => [boardId, kind]).sort(),
          notifications: notifications.map(({ boardId, kind, recipientId }) => [boardId, kind, recipientId]).sort(),
        };
      }

      const failures = [];
      for (const entry of mcpMutationCatalog) {
        const { name } = entry;
        try {
          const raw = cases[name];
          const idempotencyKey = randomUUID();
          const wire = mcpMutationWireSchema(entry);
          assert.equal(wire.type, 'object');
          for (const alt of wire.anyOf ?? [wire]) {
            assert.equal(alt.additionalProperties, false);
            assert.ok(alt.required.includes('idempotencyKey'));
          }
          await caseSetup(f, name);
          const userId = adminOperations.has(name) ? ids.admin : actor;
          const cookie = cookies.get(userId);
          const token = readSessionCookie(cookie);
          const denied = await deny.fetch(new Request(origin + '/mcp', { method: 'POST', headers: {
            Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2025-11-25', Authorization: 'Bearer fixture-read-token-synthetic',
          } }), { parsedBody: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...raw, idempotencyKey } } } });
          assert.equal(denied.status, 403);
          assert.match(denied.headers.get('www-authenticate'), /insufficient_scope/u);
          assert.equal(await f.db.collection('commands').countDocuments(f.scope), 0);
          const runMutation = (args, key) => executeMcpMutation({
            database: f.db, installationId: f.installationId, gate: f.gate, actorId: userId, media,
            resolve: () => resolveBrowserWorkspace(f.db, f.installationId, token, f.now()),
            attribution: { origin: 'mcp', clientId: 'registered:fixture-a' },
          }, name, { ...args, idempotencyKey: key });
          if (name === 'card_move') {
            const stale = { ...raw, sourceOrderVersion: 999 };
            const rejected = await runMutation(stale, randomUUID()).catch(mcpMutationError);
            assert.equal(rejected.isError, true);
            const { path, options } = restTarget(entry, stale, randomUUID(), cookie);
            const web = await f.call(path, cookie, options);
            assert.equal(web.status, 409);
            const { requestId: _requestId, ...expected } = web.data.error;
            assert.deepEqual(JSON.parse(rejected.content[0].text), expected);
          }
          const result = await runMutation(raw, idempotencyKey);
          assert.ok(result.structuredContent);
          const after = await snapshot();
          const cmd = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey });
          assert.equal(cmd.status, 'committed');
          const audit = await f.db.collection('auditEntries').findOne({ ...f.scope, commandId: cmd.id });
          assert.deepEqual([audit.origin, audit.clientId, audit.actorId], ['mcp', 'registered:fixture-a', userId]);
          const { path, options, status } = restTarget(entry, raw, idempotencyKey, cookie);
          const response = await f.call(path, cookie, options);
          assert.equal(response.status, status, JSON.stringify(response.data));
          if (status === 204) {
            assert.equal(response.data, '');
            assert.deepEqual(result.structuredContent.data, { acknowledged: true,
              ...Object.fromEntries([['parentRevision', relationshipParentRevisionHeader.toLowerCase()], ['removedGroups', 'x-planner-removed-groups'],
                ['removedValues', 'x-planner-removed-values']].filter(([, key]) => response.headers[key] !== undefined)
                .map(([field, key]) => [field, Number(response.headers[key])])) });
          } else {
            assert.deepEqual(result.structuredContent, response.data);
          }
          assert.deepEqual(await snapshot(), after, 'REST retry changed a durable command effect');

          const mcpEffects = await effectSummary(cmd);
          assert.equal(mcpEffects.audit[0], entry.kind === 'relationship' ? entry.operation : mediaOperations[entry.operation].id);
          await restore();
          await caseSetup(f, name);
          const fresh = await f.call(path, cookie, options);
          assert.equal(fresh.status, status);
          const webCommand = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey });
          assert.equal(webCommand.status, 'committed');
          assert.deepEqual(await effectSummary(webCommand), mcpEffects);
        } catch (error) {
          failures.push(new Error(name + ' failed: ' + error.message, { cause: error }));
        } finally { await restore(); }
      }
      assert.deepEqual(failures.map(({ message }) => message), []);
    } finally { await deny.close(); await f.close(); }
  }));


test('durable mutation recovery retains the first client and current authorization conceals foreign targets',
  { timeout: 45000 }, async () => withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const cookie = cookieOf(await f.login(actor));
    const editorCookie = cookieOf(await f.login(ids.firstEditor));
    const scopeFor = (cookie) => () => resolveBrowserWorkspace(f.db, f.installationId, readSessionCookie(cookie), f.now());
    const resolution = scopeFor(cookie);
    const actorFor = (userId, authCookie) => ({
      database: f.db, installationId: f.installationId, gate: f.gate,
      actorId: userId, resolve: scopeFor(authCookie), attribution: { origin: 'mcp', clientId: 'claude-code' },
    });
    try {
      await seed(f);
      for (const [checkpoint, revision, client] of [['building', 1, 'codex'], ['prepared', 2, 'claude-connector']]) {
        const input = { id: board, expectedRevision: revision, name: 'Recovered ' + checkpoint };
        const idempotencyKey = randomUUID();
        const cut = new Error('Synthetic interruption after ' + checkpoint);
        const first = new CommandJournal(f.gate, f.db, f.installationId, {
          operations: createRelationshipJournalOperations(f.db, resolution),
          attribution: { origin: 'mcp', clientId: client },
          checkpoint: (step) => { if (step === checkpoint) throw cut; },
        });
        await assert.rejects(first.execute({ actorId: actor, operationId: 'boards.update', idempotencyKey, input }), cut);
        assert.equal(f.gate.ready, false);
        await new CommandJournal(f.gate, f.db, f.installationId).recover();
        const receipt = await executeMcpMutation(actorFor(actor, cookie), 'board_update', { ...input, idempotencyKey });
        assert.equal(receipt.structuredContent.data.board.name, input.name);
        const command = await f.db.collection('commands').findOne({ ...f.scope, idempotencyKey });
        const audits = await f.db.collection('auditEntries').find({ ...f.scope, commandId: command.id }).toArray();
        assert.equal(audits.length, 1);
        assert.deepEqual([audits[0].actorId, audits[0].origin, audits[0].clientId], [actor, 'mcp', client]);
      }

      const blocked = async (name, args) => JSON.parse((await executeMcpMutation(actorFor(ids.firstEditor, editorCookie), name,
        { ...args, idempotencyKey: randomUUID() }).catch(mcpMutationError)).content[0].text);
      const concealed = { ...cases.card_move, toListId: ids.hiddenActiveList, destinationBoardId: ids.hiddenBoard };
      const missing = { ...concealed, toListId: randomUUID(), destinationBoardId: randomUUID() };
      assert.deepEqual(await blocked('card_move', concealed), await blocked('card_move', missing));
      const foreign = await blocked('notification_update', cases.notification_update);
      assert.equal(foreign.code, 'NOT_FOUND');
      assert.deepEqual(foreign, await blocked('notification_update', { ...cases.notification_update, id: randomUUID() }));
      assert.equal((await f.db.collection('notifications').findOne({ ...f.scope, id: notice })).readAt, null);

      // A large imported field group is valid for REST and can exceed the MCP result limit.
      for (let i = 0; i < 350; i += 1) {
        await f.insert('fieldDefinitions', fixtureId(6000 + i), {
          fieldGroupId: group, name: 'Field ' + i + ' ' + 'x'.repeat(60), rank: String((i + 1) * 1024),
        });
      }
      const oversized = { id: group, expectedRevision: 1, name: 'Large field group' };
      const rejectedKey = randomUUID();
      const refused = await executeMcpMutation(actorFor(actor, cookie), 'field_update_group',
        { ...oversized, idempotencyKey: rejectedKey }).catch(mcpMutationError);
      assert.equal(JSON.parse(refused.content[0].text).code, 'RESULT_TOO_LARGE');
      assert.equal((await f.db.collection('fieldGroups').findOne({ ...f.scope, id: group })).revision, 1);
      const entry = mcpMutationCatalog.find(({ name }) => name === 'field_update_group');
      const committedKey = randomUUID();
      const { path, options } = restTarget(entry, oversized, committedKey, cookie);
      const web = await f.call(path, cookie, options);
      assert.equal(web.status, 200);
      assert.equal(web.data.data.group.definitions.length, 351);
      const replay = await executeMcpMutation(actorFor(actor, cookie), 'field_update_group',
        { ...oversized, idempotencyKey: committedKey });
      assert.deepEqual(replay.structuredContent, { data: { acknowledged: true, resultOmitted: true } });
      assert.equal((await f.db.collection('fieldGroups').findOne({ ...f.scope, id: group })).revision, 2);
    } finally { await f.close(); }
  }));
