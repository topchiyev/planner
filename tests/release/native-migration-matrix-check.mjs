import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectVerifiedNativeMongo } from '/opt/planner/current/apps/backend/dist/native/mongo-readiness.js';
import { acquireNativeWriter } from '/opt/planner/current/apps/backend/dist/native/writer.js';
import { legacyPublicId } from '/opt/planner/current/apps/backend/dist/storage/identity.js';
import { createPasswordHasher } from '/opt/planner/current/apps/backend/dist/application/auth/password.js';
import { sha256, sharedImageKey, sharedTextKey, privateTextKey, missingOriginal } from './planka/matrix-oracle.mjs';

const [runId, cert, codePath, fixtures, release, scenario, work] = process.argv.slice(2);
assert.equal(process.getuid(), 0);
assert.ok(['clean', 'inconsistent'].includes(scenario));
const clean = scenario === 'clean';
const ca = await readFile(cert);
const hostname = 'planner.example.test';
const apiRoot = '/api/v1';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

function api(path, { method = 'GET', body, session, headers } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ hostname: '127.0.0.1', servername: hostname, ca, path, method, headers: {
      Host: hostname, Origin: 'https://' + hostname,
      ...(encoded !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
      ...(session && { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }), ...headers,
    } }, (incoming) => {
      const parts = [];
      incoming.on('data', (part) => parts.push(part));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const bytes = Buffer.concat(parts);
        const json = bytes.length && (incoming.headers['content-type'] ?? '').includes('application/json')
          ? JSON.parse(bytes.toString()) : null;
        resolve({ status: incoming.statusCode, json, bytes, headers: incoming.headers });
      });
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('HTTPS verification timed out.')));
    outgoing.on('error', reject).end(encoded);
  });
}

async function readiness(expected) {
  for (let count = 0; count < 160; count++) {
    if ((await api('/health/ready').catch(() => undefined))?.status === expected) return;
    await delay(100);
  }
  assert.fail(`Expected HTTPS readiness ${expected}.`);
}

function operator(action, options = [], fault) {
  const cmd = ['migration', action, '--run', runId, ...options, '--format', 'json'];
  if (fault) {
    const result = spawnSync('/usr/bin/plannerctl', cmd, { encoding: 'utf8' });
    assert.equal(result.status, 1, `Expected ${action} to refuse with ${fault}.`);
    assert.equal(JSON.parse(result.stderr).fault, fault);
    return;
  }
  return JSON.parse(execFileSync('/usr/bin/plannerctl', cmd, { encoding: 'utf8' }));
}

async function signIn(identifier, password, code) {
  let response = await api(apiRoot + '/session/login', { method: 'POST', body: { identifier, password } });
  assert.equal(response.status, 200);
  if (code) {
    assert.equal(response.json.status, 'challenge-required');
    response = await api(apiRoot + '/session/verify-mfa', { method: 'POST',
      body: { challengeId: response.json.challengeId, recoveryCode: code } });
  }
  assert.equal(response.status, 200);
  assert.equal(response.json.status, 'authenticated');
  const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
  assert.ok(cookie);
  return { cookie, csrfToken: response.json.csrfToken, actor: response.json.account.id };
}

async function data(path, session) {
  const result = await api(apiRoot + path, { session });
  assert.equal(result.status, 200, path);
  return result.json;
}

async function assertDownload(path, session, sourceBytes) {
  const result = await api(apiRoot + path, { session });
  assert.equal(result.status, 200, path);
  assert.deepEqual(result.bytes, sourceBytes);
  assert.equal(sha256(result.bytes), sha256(sourceBytes));
  assert.equal(result.headers['content-length'], String(sourceBytes.length));
  assert.equal(result.headers['content-type'], 'application/octet-stream');
  assert.match(result.headers.etag, /^"[0-9a-f]{64}"$/u);
  const head = await api(apiRoot + path, { method: 'HEAD', session });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers['content-length'], String(sourceBytes.length));
  assert.equal(head.headers.etag, result.headers.etag);
  const range = await api(apiRoot + path, { session, headers: { Range: 'bytes=1-4', 'If-Range': result.headers.etag } });
  assert.equal(range.status, 206);
  assert.deepEqual(range.bytes, sourceBytes.subarray(1, 5));
  assert.equal(range.headers['content-range'], `bytes 1-4/${sourceBytes.length}`);
  const unchanged = await api(apiRoot + path, { session, headers: { 'If-None-Match': result.headers.etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.bytes.length, 0);
  return result.headers.etag;
}

async function assertNoFile(path, session, headers) {
  for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=1-4' } }, { headers }]) {
    const result = await api(apiRoot + path, { session, ...options });
    assert.equal(result.status, 404, path);
    if (options.method === 'HEAD') assert.equal(result.bytes.length, 0);
    else assert.equal(result.json?.error.code, 'NOT_FOUND');
    for (const name of ['content-disposition', 'content-range', 'etag', 'accept-ranges']) assert.equal(result.headers[name], undefined);
  }
}

async function activate(manifestSha256, missingCount) {
  await readiness(503);
  const flags = ['--expect-manifest', manifestSha256];
  operator('activate', ['--expect-manifest', '0'.repeat(64)], 'approval-invalid');
  if (missingCount) {
    operator('activate', flags, 'approval-required');
    const approval = join(work, 'approval.json');
    const wrong = join(work, 'approval-invalid.json');
    const exact = { runId, snapshotSha256: manifestSha256, missing: [missingOriginal] };
    await writeFile(wrong, JSON.stringify({ ...exact, snapshotSha256: '0'.repeat(64) }), { mode: 0o600, flag: 'wx' });
    await writeFile(approval, JSON.stringify(exact), { mode: 0o600, flag: 'wx' });
    const details = await stat(approval);
    assert.equal(details.uid, 0);
    assert.equal(details.mode & 0o777, 0o600);
    operator('activate', [...flags, '--approve-missing-assets', wrong], 'approval-invalid');
    await readiness(503);
    const withApproval = [...flags, '--approve-missing-assets', approval];
    const activated = operator('activate', withApproval);
    assert.equal(activated.state, 'activeReadOnly');
    operator('activate', flags, 'approval-required');
    operator('activate', [...flags, '--approve-missing-assets', wrong], 'approval-invalid');
    assert.deepEqual(operator('activate', withApproval), activated);
  } else {
    const activated = operator('activate', flags);
    assert.equal(activated.state, 'activeReadOnly');
    assert.deepEqual(operator('activate', flags), activated);
  }
  assert.equal(operator('status').state, 'activeReadOnly');
  await readiness(200);
}

const credential = await readJson('/etc/planner/mongodb-app.json');
const client = await connectVerifiedNativeMongo(credential);
try {
  const db = client.db('planner');
  const run = await db.collection('importRuns').findOne({ installationId: credential.installationId, id: runId });
  assert.equal(run.state, 'verified');
  assert.equal(run.source.release, release);
  const { generationId, manifestSha256 } = run;
  const id = (table, source) => legacyPublicId(run.source.instanceId, table, source);
  const readGeneration = (name, query = {}) => db.collection(name).find({ generationId, ...query }).sort({ id: 1 }).toArray();
  const accountIds = ['102', '103', '104', '105'].map((source) => id('user_account', source));
  const syntheticPassword = 'Synthetic matrix credential 🧪';
  const aclEdges = async () => Promise.all(['projectManagers', 'boardMembers', 'cardAssignees'].map((name) => readGeneration(name)));
  const accountScope = { generationId, id: { $in: accountIds }, requiresMfaEnrollment: false };
  const stripCredential = ({ localAuth, revision, ...record }) => record;
  assert.equal((await db.collection('installation').findOne({ _id: 'installation' })).activeGenerationId, null);
  const lease = acquireNativeWriter();
  try {
    const before = await readGeneration('users', accountScope);
    assert.equal(before.length, 4);
    for (const { id: userId, localAuth, disabledAt } of before) {
      assert.deepEqual(localAuth, { passwordVerifier: null, credentialsVersion: 1, mfa: 'none' });
      assert.equal(disabledAt !== null, userId === accountIds[3]);
    }
    const edgesBefore = await aclEdges();
    const passwordVerifier = await createPasswordHasher().encode(syntheticPassword);
    const updated = await db.collection('users').updateMany(accountScope, {
      $set: { localAuth: { passwordVerifier, credentialsVersion: 2, mfa: 'none' } }, $inc: { revision: 1 },
    }, { writeConcern: { w: 1, j: true } });
    assert.equal(updated.modifiedCount, 4);
    assert.deepEqual((await readGeneration('users', accountScope)).map(stripCredential), before.map(stripCredential));
    assert.deepEqual(await aclEdges(), edgesBefore);
  } finally { lease.release(); }

  const archivedId = id('card', '9007199254740996');
  const [archivedMap] = await readGeneration('importIds', { entity: 'card', sourceId: '9007199254740996' });
  assert.equal(archivedMap.provenance.previousListSourceId, '499');
  const [action] = await readGeneration('importIds', { entity: 'action', sourceId: '711' });
  assert.equal(action.provenance.discussion.boardSourceId, clean ? '301' : null);
  assert.deepEqual(action.provenance.discussion.decoded.snapshot, {
    fromList: { id: '499', type: 'closed', name: 'Earlier batch' },
    toList: { id: '403', type: 'archive', name: null },
  });
  const quarantines = await readGeneration('importQuarantine');
  if (clean) assert.deepEqual(quarantines, []);
  else {
    assert.equal(quarantines.length, 1);
    assert.equal(quarantines[0].sourceId, '721');
    assert.equal(quarantines[0].sourceIsRead, false);
    assert.deepEqual(quarantines[0].reasons, ['missing-card', 'missing-activity']);
  }

  execFileSync('/usr/bin/systemctl', ['start', 'planner.service']);
  await activate(manifestSha256, Number(!clean));
  const admin = await signIn('iris@planner-fixture.invalid', '  Owned äccount 🗝️ pass & %  ', (await readFile(codePath, 'utf8')).trim());
  const owner = await signIn('rowan@planner-fixture.invalid', syntheticPassword);
  const viewer = await signIn('sage@planner-fixture.invalid', syntheticPassword);
  const silentViewer = await signIn('teal@planner-fixture.invalid', syntheticPassword);
  assert.deepEqual([admin.actor, owner.actor, viewer.actor, silentViewer.actor],
    [id('user_account', '101'), ...accountIds.slice(0, 3)]);
  const disabled = await api(apiRoot + '/session/login', { method: 'POST',
    body: { identifier: 'yarrow@planner-fixture.invalid', password: syntheticPassword } });
  assert.equal(disabled.status, 401);
  assert.equal(disabled.json.error.code, 'INVALID_CREDENTIALS');
  assert.equal(disabled.headers['set-cookie'], undefined);

  const board = '/boards/' + id('board', '301');
  const privateBoard = '/boards/' + id('board', '302');
  assert.equal((await data(privateBoard, owner)).data.id, id('board', '302'));
  assert.equal((await api(apiRoot + privateBoard, { session: admin })).status, 404);
  assert.equal((await api(apiRoot + privateBoard, { session: viewer })).status, 404);
  for (const [session, canComment] of [[viewer, true], [silentViewer, false]]) {
    const { permissions } = (await data(board, session)).data;
    assert.deepEqual([permissions.canComment, permissions.canEdit], [canComment, false]);
  }
  const archived = (await data('/cards/' + archivedId, owner)).data;
  assert.equal(archived.previousListId, clean ? id('list', '499') : null);
  const activity = (await data(board + '/activity', owner)).data.find((row) => row.id === id('action', '711'));
  assert.equal(activity.kind, 'moveCard');
  assert.equal(activity.card.id, archivedId);
  assert.equal(activity.actor?.id ?? null, clean ? owner.actor : null);
  const viewerInbox = await data('/notifications', viewer);
  assert.deepEqual(viewerInbox.data.map(({ id: notification, readAt }) => [notification, readAt]),
    clean ? [[id('notification', '721'), null]] : []);
  assert.equal(viewerInbox.unreadCount, Number(clean));
  const ownerInbox = await data('/notifications', owner);
  const capture = await readJson(join(fixtures, release, 'manifest.json'));
  assert.deepEqual(ownerInbox.data.map(({ id: notification, readAt }) => [notification, readAt]),
    [[id('notification', '722'), capture.capturedAt]]);
  assert.equal(ownerInbox.unreadCount, 0);

  const card = '/cards/' + id('card', '9007199254740993');
  const viewerTasks = (await data(card + '/checklists', viewer)).data[0].tasks;
  assert.deepEqual(viewerTasks.map(({ kind }) => kind), ['linked', 'unavailable', 'task']);
  assert.deepEqual(Object.keys(viewerTasks[1]).sort(), ['checklistId', 'createdAt', 'id', 'kind', 'rank', 'revision', 'updatedAt']);
  const ownerTasks = (await data(card + '/checklists', owner)).data[0].tasks;
  assert.equal(ownerTasks[1].linkedCard.id, id('card', '9007199254740998'));
  const comments = (await data(card + '/comments', viewer)).data;
  assert.deepEqual(comments.map(({ id: comment, text, author }) => [comment, text, author?.id]),
    [[id('comment', '701'), 'Measured twice.', viewer.actor]]);

  const assetManifest = await readJson(join(fixtures, release, 'asset-manifest.json'));
  async function sourceBytes(key) {
    const asset = assetManifest.files.find((entry) => entry.key === key);
    assert.ok(asset);
    const bytes = await readFile(join(fixtures, release, 'assets', key));
    assert.equal(bytes.length, asset.size);
    assert.equal(sha256(bytes), asset.sha256);
    return bytes;
  }
  const image = await sourceBytes(sharedImageKey);
  assert.notEqual(sharedImageKey, sharedImageKey.normalize('NFC'));
  const derivativeKeys = [360, 720].map((size) =>
    `private/attachments/${missingOriginal.sourceId}/thumbnails/outside-${size}.png`);
  const derivativeBytes = await Promise.all(derivativeKeys.map(sourceBytes));
  for (const [sourceId, cardSourceId] of [['601', '9007199254740993'], ['602', '9007199254740994']]) {
    const [mapping] = await readGeneration('importIds', { entity: 'attachment', sourceId });
    const [target] = await readGeneration('attachments', { id: id('attachment', sourceId) });
    const { uploadSourceId, original, derivatives, state } = mapping.provenance.media;
    assert.equal(uploadSourceId, missingOriginal.sourceId);
    assert.deepEqual([original.key, original.sha256, original.byteLength],
      clean ? [sharedImageKey, sha256(image), image.length] : [sharedImageKey, null, null]);
    assert.deepEqual(derivatives.map(({ key, sha256: digest, byteLength }) => [key, digest, byteLength]),
      derivativeKeys.map((key, index) => [key, sha256(derivativeBytes[index]), derivativeBytes[index].length]));
    assert.equal(target.cardId, id('card', cardSourceId));
    assert.equal(target.availability, state);
    assert.equal(target.blobDigest, original.sha256);
  }
  const expectedShared = await sourceBytes(sharedTextKey);
  const expectedPrivate = await sourceBytes(privateTextKey);
  const ownerPrivate = (await data('/cards/' + id('card', '9007199254740998'), owner)).data;
  assert.ok(ownerPrivate.attachments.some(({ id: attachment }) => attachment === id('attachment', '604')));
  assert.equal((await api(`${apiRoot}/cards/${ownerPrivate.id}`, { session: admin })).status, 404);
  const download = (source) => '/attachments/' + id('attachment', source) + '/download';
  const thumbnail = (source) => '/attachments/' + id('attachment', source) + '/thumbnail/small';
  assert.deepEqual(expectedShared, expectedPrivate);
  const sharedTag = await assertDownload(download('603'), admin, expectedShared);
  const privateTag = await assertDownload(download('604'), owner, expectedPrivate);
  assert.notEqual(privateTag, sharedTag);
  await assertNoFile(download('604'), admin, { 'If-None-Match': privateTag });
  assert.equal((await api(apiRoot + download('603'), { session: admin, headers: { 'If-None-Match': sharedTag } })).status, 304);

  const cover = id('attachment', '601');
  const detail = (await data(card, admin)).data;
  assert.equal(detail.coverAttachmentId, cover);
  const visible = detail.attachments.find(({ id: attachment }) => attachment === cover);
  assert.deepEqual([visible.available, visible.hasThumbnail], [clean, clean]);
  const cards = (await data(board + '/cards', admin)).data;
  assert.deepEqual(cards.find(({ id: item }) => item === detail.id).cover, { attachmentId: cover, hasThumbnail: clean });
  for (const source of ['601', '602']) {
    if (clean) {
      await assertDownload(download(source), admin, image);
      const thumb = await api(apiRoot + thumbnail(source), { session: admin });
      assert.equal(thumb.status, 200);
      assert.equal(thumb.headers['content-type'], 'image/png');
      assert.equal(thumb.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } else {
      await assertNoFile(download(source), admin);
      await assertNoFile(thumbnail(source), admin);
    }
  }

  const denied = await api(apiRoot + card, { method: 'PATCH', session: owner, body: { name: 'Synthetic denied edit' },
    headers: { 'If-Match': `"${detail.revision}"`, 'Idempotency-Key': randomUUID() } });
  assert.equal(denied.status, 409);
  assert.equal(denied.json.error.code, 'WORKSPACE_READ_ONLY');
  for (const [collection, expected] of [['commands', 0], ['events', 0], ['activities', 2], ['notifications', clean ? 2 : 1]]) {
    assert.equal(await db.collection(collection).countDocuments({ generationId }), expected, collection);
  }
  assert.deepEqual(await data('/notifications', viewer), viewerInbox);
  assert.deepEqual(await data('/notifications', owner), ownerInbox);
  console.log(`Matrix HTTPS ACL, MFA, read-only, scoped graph and media hashes passed ${release} ${scenario} ${sha256(expectedShared)}`);
} finally { await client.close(); }
