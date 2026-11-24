import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultPreferences } from '../../apps/backend/dist/application/auth/accounts.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { createBoardEventCursors } from '../../apps/backend/dist/application/board-events/cursor.js';
import { createBoardEventStreams } from '../../apps/backend/dist/application/board-events/streams.js';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { buildApp } from '../../apps/backend/dist/build-app.js';
import { createWorkspaceRelationships } from '../../apps/backend/dist/native/relationship-routes.js';
import { startProxySocket } from '../../apps/backend/dist/native/proxy-socket.js';
import { createWorkspaceReader } from '../../apps/backend/dist/native/workspace-routes.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { workspaceInsertFields } from '../../apps/backend/dist/storage/scoped.js';
import { createWorkspaceFixture, workspaceFixtureInstant, workspaceIds } from '../fixtures/planner-workspace.ts';
import { callSocket, password, proxyHeaders, proxyToken } from './account-fixture.mjs';

export const origin = 'https://planner.example.test';
export const ids = workspaceIds;
export const fixtureId = (sequence) => `65160d3b-4e42-4023-880e-${sequence.toString(16).padStart(12, '0')}`;

export async function makeWorkspaceAccessFixture({ db, directory }, { beforeAdmission, configureMedia, clock, heartbeatMs } = {}) {
  const installationId = randomUUID();
  const generationId = ids.generation;
  const stagedGenerationId = randomUUID();
  const now = clock ?? (() => new Date('2026-03-19T13:13:59.719Z'));
  const source = createWorkspaceFixture();
  const hasher = createPasswordHasher();
  const passwordVerifier = await hasher.encode(password);
  const scope = { generationId };

  await db.collection('installation').insertOne({
    _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: generationId,
    setup: { mode: 'fresh', pendingAction: 'complete' },
  });
  await migrateStorageSchema(db, installationId);

  function canonical(name, sourceRow, generation) {
    const { id, revision, generationId: _sourceGeneration, ...fields } = sourceRow;
    return { ...workspaceInsertFields(name, fields, revision), _id: workspaceKey(generation, id), generationId: generation, id };
  }
  async function insert(name, id, fields, generation = generationId) {
    const row = { id, revision: 1, createdAt: workspaceFixtureInstant, updatedAt: workspaceFixtureInstant, ...fields };
    await db.collection(name).insertOne(canonical(name, row, generation));
    return id;
  }
  async function seed(generation, staged = false) {
    const lists = new Map(source.lists.map((entry) => [entry.id, entry]));
    const users = source.users.map(({ disabled, ...row }) => ({
      ...canonical('users', { ...row, normalizedEmail: row.email.toLowerCase(), normalizedUsername: row.username?.toLowerCase() ?? null,
        disabledAt: disabled ? now() : null, preferences: defaultPreferences }, generation),
      localAuth: { passwordVerifier, credentialsVersion: 1, mfa: 'none' },
    }));
    const rows = {
      projects: source.projects.map((row, i) => ({ ...row, rank: String((i + 1) * 1024) })),
      projectManagers: source.projectManagers,
      boards: source.boards.map((row, i) => ({ ...row, rank: String((i + 1) * 1024), orderVersion: 1 })),
      boardMembers: source.boardMembers.filter(({ userId }) => !staged || userId !== ids.viewer),
      lists: source.lists.map((row) => ({ ...row, orderVersion: 1 })),
      cards: source.cards.map((row) => {
        const list = lists.get(row.listId);
        return {
          ...row, kind: list.kind === 'archive' || list.kind === 'trash' ? list.kind : 'board', description: 'Synthetic dispatch',
          closed: row.id === ids.sharedTarget, listChangedAt: workspaceFixtureInstant, historySequence: '9007199254740993',
          ...(staged && row.id === ids.activeCard && { name: 'Staged restricted identity' }),
        };
      }),
      cardAssignees: source.cardAssignees,
      checklists: source.checklists,
      tasks: source.tasks,
      fieldGroups: source.fieldGroups.map(({ boardId, ...row }) => ({ ...row, scopeType: 'board', scopeId: boardId })),
      fieldDefinitions: source.fieldDefinitions.map(({ groupId, ...row }) => ({ ...row, fieldGroupId: groupId })),
      fieldValues: source.fieldValues.map(({ groupId, definitionId, ...row }) => ({ ...row, fieldGroupId: groupId, fieldDefinitionId: definitionId })),
    };
    await db.collection('users').insertMany(users);
    for (const [name, values] of Object.entries(rows)) {
      await db.collection(name).insertMany(values.map((row) => canonical(name, row, generation)));
    }
    if (staged) {
      await insert('boardMembers', fixtureId(500), { boardId: ids.privateBoard, userId: ids.admin, role: 'editor', canComment: null }, generation);
    }
  }
  await seed(generationId);
  await seed(stagedGenerationId, true);

  const writer = join(directory, 'writer');
  await mkdir(writer);
  await chmod(writer, 0o750);
  const owner = { uid: process.getuid(), gid: process.getgid() };
  const gate = new CommandGate(acquireWriterDirectory(writer, owner, owner));
  await new CommandJournal(gate, db, installationId).recover();
  const sessions = createBrowserSessions(db, installationId, gate, hasher, now);
  const cursorKey = createSecretKey(randomBytes(32));
  const cursors = createBoardEventCursors(cursorKey);
  const reader = createWorkspaceReader(db, installationId, gate, cursors, now);
  const streams = createBoardEventStreams(async () => db, installationId, gate, cursors, { now, heartbeatMs });
  const media = await configureMedia?.({ db, directory, installationId, generationId, gate, now });
  const app = buildApp({
    native: { origin, proxyToken, readAccess: async () => gate.ready ? ({ kind: 'ready' }) : ({ kind: 'unavailable' }), workspace: reader,
      media, boardEvents: streams,
      relationships: createWorkspaceRelationships(db, installationId, gate, now, undefined, streams.revalidateBoards), auth: {
      confirm: async () => false, login: sessions.login,
      async revoke(token) {
        const revoked = await sessions.revoke(token);
        if (revoked) streams.disconnectToken(token);
        return revoked;
      },
      async read(token) {
        const session = await sessions.read(token);
        await beforeAdmission?.({ session, db, gate, generationId });
        return session;
      },
    } },
  });
  const dir = join(directory, 'proxy');
  await mkdir(dir);
  await chmod(dir, 0o711);
  const closeProxy = await startProxySocket(dir, app);

  function call(path, cookie, options = {}) {
    return callSocket(join(dir, 'http.sock'), path, { ...options, headers: {
      ...proxyHeaders(origin), ...(cookie && { Cookie: cookie }), ...options.headers,
    } });
  }
  return {
    db, installationId, generationId, stagedGenerationId, scope, gate, reader, now, call, insert, streams, cursors, cursorKey, socketPath: join(dir, 'http.sock'),
    async login(id) {
      const account = source.users.find((row) => row.id === id);
      return call('/api/v1/session/login', null, { method: 'POST', headers: { Origin: origin },
        body: { identifier: account.email, password } });
    },
    close: async () => { streams.stop(); await closeProxy(); await app.close(); await gate.closeAndDrain(); },
  };
}

export const cookieOf = (result) => result.headers['set-cookie']?.[0]?.split(';')[0];
