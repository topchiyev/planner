import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, readdir, readlink, stat, utimes, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { maximumMediaBytes } from '@planner/contracts';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { CommandJournal } from '../../apps/backend/dist/application/command-journal/journal.js';
import { createMediaDecoder } from '../../apps/backend/dist/application/media/decoder.js';
import { sweepPrivateMedia, mediaOrphanGraceMs, verifyActiveMedia } from '../../apps/backend/dist/application/media/reconcile.js';
import { createMediaService } from '../../apps/backend/dist/application/media/service.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';
import { proxyHeaders } from '../support/account-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);
const cardPath = (id) => `/api/v1/cards/${id}`;
const filePath = (id) => `/api/v1/attachments/${id}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const formats = new URL('../fixtures/media/', import.meta.url);
const uploads = ['jpeg', 'png', 'gif', 'webp'].map((format) => [format, new URL(`sample.${format}`, formats)]);
const checksum = (data) => createHash('sha256').update(data).digest('hex');
const expected = (cookie, revision, key = randomUUID()) => ({ Origin: origin,
  'X-Csrf-Token': csrfToken(readSessionCookie(cookie)), 'If-Match': `"${revision}"`, 'Idempotency-Key': key });

async function login(f, id) {
  const result = await f.login(id);
  assert.equal(result.status, 200);
  return cookieOf(result);
}

function socket(f, path, cookie, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: f.socketPath, path, method, headers: { ...proxyHeaders(origin),
      ...(cookie && { Cookie: cookie }), ...headers } }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const data = bytes.length && response.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes) : undefined;
        resolve({ status: response.statusCode, headers: response.headers, bytes, data });
      } catch (error) { reject(error); }
    });
    req.once('error', reject);
    if (!body) return req.end();
    Readable.from(body).pipe(req);
  });
}

function form(bytes, name, declared = bytes.length) {
  const boundary = 'PlannerAcceptanceBoundary';
  const start = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="byteLength"\r\n\r\n${declared}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': start.length + bytes.length + end.length },
    body: [start, bytes, end] };
}

function upload(f, path, cookie, revision, bytes, name, { key, method = 'POST', declared } = {}) {
  const { headers, body } = form(bytes, name, declared);
  return socket(f, path, cookie, { method, headers: { ...headers, ...expected(cookie, revision, key) }, body });
}

async function withMedia(run, options) {
  return withFixtureMongo(async (mongo) => {
    const blobPath = join(mongo.directory, 'blobs');
    const stagePath = join(mongo.directory, 'staging');
    await mkdir(blobPath, { mode: 0o700 });
    await mkdir(stagePath, { mode: 0o700 });
    const store = await createPrivateMediaStore(stagePath, blobPath);
    const decode = createMediaDecoder(fileURLToPath(new URL('../../ops/package/decode-media.py', import.meta.url)),
      process.env.PLANNER_TEST_MEDIA_PYTHON ?? undefined);
    const fixture = await makeWorkspaceAccessFixture(mongo, { configureMedia({ db, installationId, gate, now }) {
      const service = createMediaService(db, installationId, gate, store, options?.decoder?.(decode) ?? decode,
        { now, checkpoint: options?.checkpoint });
      return (callback) => callback(service);
    } });
    try { return await run(fixture, { store, blobPath, stagePath }); }
    finally { await fixture.close(); await store.close(); }
  });
}

const decoderAvailable = Boolean(process.env.PLANNER_TEST_MEDIA_PYTHON)
  || (await import('node:child_process')).spawnSync('/usr/bin/python3', ['-I', '-B', '-c', 'import PIL']).status === 0;

// The binary/authorization path runs even on local developer systems without the Ubuntu decoder.
test('private streaming upload authorizes exact logical references and replays its original revision', { timeout: 100_000 }, async () => {
  await withMedia(async (f, { blobPath, stagePath }) => {
    const editor = await login(f, ids.firstEditor);
    const viewer = await login(f, ids.viewer);
    const admin = await login(f, ids.admin);
    const path = `${cardPath(ids.activeCard)}/attachment-files`;
    const original = Buffer.from([0, 0x80, 0xff, 0x41, 0x20]);
    const key = randomUUID();
    assert.equal((await upload(f, path, viewer, 1, original, 'sample.dat')).status, 403);
    assert.equal((await upload(f, path, admin, 1, original, 'sample.dat')).status, 404);
    assert.equal((await upload(f, path, editor, 1, original, 'sample.dat', { declared: 6 })).status, 422);
    assert.deepEqual(await readdir(stagePath), []);
    const first = await upload(f, path, editor, 1, original, 'sample.dat', { key });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const { reference, parent } = first.data.data;
    assert.equal(parent.revision, 2);
    const replay = await upload(f, path, editor, 1, original, 'sample.dat', { key });
    assert.equal(replay.status, 201, JSON.stringify(replay.data));
    assert.deepEqual(replay.data, first.data);
    assert.equal((await upload(f, path, editor, 1, Buffer.from('different'), 'sample.dat', { key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await upload(f, path, editor, 1, original, 'sample.dat')).data.error.code, 'REVISION_CONFLICT');
    const duplicate = await upload(f, `${cardPath(ids.sharedTarget)}/attachment-files`, editor, 1, original, 'duplicate.dat');
    assert.equal(duplicate.status, 201, JSON.stringify(duplicate.data));
    assert.notEqual(duplicate.data.data.reference.id, reference.id);
    assert.deepEqual((await readdir(blobPath)).sort(), [checksum(original), checksum(Buffer.from('different'))].sort());
    assert.equal(await f.db.collection('blobs').countDocuments({ digest: checksum(original) }), 1);
    assert.equal(await f.db.collection('blobs').countDocuments({ digest: checksum(Buffer.from('different')) }), 0);
    assert.equal((await stat(join(blobPath, checksum(original)))).mode & 0o777, 0o400);
    const download = `${filePath(reference.id)}/download`;
    const full = await socket(f, download, viewer);
    assert.equal(full.status, 200);
    assert.deepEqual(full.bytes, original);
    assert.equal(full.headers['content-type'], 'application/octet-stream');
    assert.match(full.headers['content-disposition'], /^attachment; /);
    assert.equal(full.headers['cache-control'], 'private, no-store');
    assert.equal(full.headers['x-content-type-options'], 'nosniff');
    const head = await socket(f, download, viewer, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(original.length));
    const partial = await socket(f, download, viewer, { headers: { Range: 'bytes=1-3' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], 'bytes 1-3/5');
    assert.deepEqual(partial.bytes, original.subarray(1, 4));
    assert.equal((await socket(f, download, viewer, { headers: { Range: 'bytes=20-' } })).status, 416);
    assert.equal((await socket(f, download, viewer, { headers: { 'If-None-Match': full.headers.etag } })).status, 304);
    const denied = await socket(f, `${filePath(duplicate.data.data.reference.id)}/download`, viewer,
      { method: 'HEAD', headers: { Range: 'bytes=0-1', 'If-None-Match': '*' } });
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.etag, undefined);
    assert.equal(denied.headers['content-range'], undefined);
    const removeHeaders = expected(editor, 1);
    const deleted = await f.call(filePath(reference.id), editor, { method: 'DELETE', headers: removeHeaders });
    assert.equal(deleted.status, 204, JSON.stringify(deleted.data));
    assert.equal(deleted.headers['planner-parent-revision'], '3');
    assert.equal((await f.call(filePath(reference.id), editor, { method: 'DELETE', headers: removeHeaders })).status, 204);
    assert.equal((await socket(f, download, viewer)).status, 404);
    assert.equal((await f.call(cardPath(ids.activeCard), editor)).data.data.attachments.some(({ id }) => id === reference.id), false);
    assert.deepEqual(await readdir(stagePath), []);
    const oldLink = fixtureId(5001);
    await f.insert('attachments', oldLink, { cardId: ids.activeCard, kind: 'link', url: 'javascript:unsafe', name: 'Old imported link' });
    const renameHeaders = expected(editor, 1);
    const rename = () => f.call(filePath(oldLink), editor, { method: 'PATCH', headers: renameHeaders, body: { name: 'Renamed' } });
    const renamed = await rename();
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.data.reference.url, null);
    assert.equal(renamed.data.data.reference.available, false);
    const addPath = `${cardPath(ids.activeCard)}/attachment-links`;
    assert.equal((await f.call(addPath, editor, { method: 'POST', headers: expected(editor, 4), body: { name: 'Bad scheme', url: 'file:///etc/host' } })).status, 422);
    const link = await f.call(addPath, editor, { method: 'POST', headers: expected(editor, 4), body: { name: 'Guide', url: 'HTTPS://EXAMPLE.TEST' } });
    assert.equal(link.status, 201);
    assert.equal(link.data.data.reference.url, 'https://example.test/');
    assert.equal((await f.call(filePath(oldLink), editor, { method: 'DELETE', headers: expected(editor, 2) })).status, 204);
    assert.equal((await rename()).status, 404);
  });
});

test('native Pillow derivatives are bounded and metadata-free with distinct avatar and background scope',
  { timeout: 100_000, skip: !decoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async () => {
    const { readFile } = await import('node:fs/promises');
    await withMedia(async (f, { store }) => {
      const editor = await login(f, ids.firstEditor);
      const viewer = await login(f, ids.viewer);
      const owner = await login(f, ids.privateOwner);
      const path = `${cardPath(ids.activeCard)}/attachment-files`;
      const staleCover = fixtureId(5100);
      await f.insert('attachments', staleCover, { cardId: ids.activeCard, name: 'Unavailable imported cover', kind: 'file', availability: 'unavailable' });
      await f.db.collection('cards').updateOne({ id: ids.activeCard, generationId: f.generationId }, { $set: { coverAttachmentId: staleCover } });
      const imported = (await f.call(cardPath(ids.activeCard), editor)).data.data;
      assert.equal(imported.coverAttachmentId, staleCover);
      assert.equal(imported.attachments.find(({ id }) => id === staleCover).available, false);
      assert.equal((await socket(f, `${filePath(staleCover)}/thumbnail/small`, viewer)).status, 404);
      const pinned = await upload(f, path, editor, 1, await readFile(new URL('sample.png', formats)), 'pinned-cover.png');
      assert.equal(pinned.status, 201);
      assert.equal(pinned.data.data.parent.coverAttachmentId, staleCover);
      const missingCover = fixtureId(5101);
      await f.db.collection('cards').updateOne({ id: ids.activeCard, generationId: f.generationId }, { $set: { coverAttachmentId: missingCover } });
      assert.equal((await f.call(cardPath(ids.activeCard), editor)).data.data.coverAttachmentId, null);
      let revision = 2;
      let cover;
      for (const [format, file] of uploads) {
        const source = await readFile(file);
        const attached = await upload(f, path, editor, revision, source, `source.${format}`);
        assert.equal(attached.status, 201, `${format}: ${JSON.stringify(attached.data)}`);
        const { reference, parent } = attached.data.data;
        cover ??= reference.id;
        assert.equal(parent.coverAttachmentId, cover);
        revision = parent.revision;
        for (const [variant, width] of [['small', 320], ['large', 480]]) {
          const image = await socket(f, `${filePath(reference.id)}/thumbnail/${variant}`, viewer);
          assert.equal(image.status, 200);
          assert.equal(image.headers['content-type'], 'image/png');
          assert.equal(image.headers['content-disposition'], undefined);
          assert.equal(image.bytes.readUInt32BE(16), width);
          const chunks = [];
          for (let offset = 8; offset < image.bytes.length;) {
            chunks.push(image.bytes.toString('ascii', offset + 4, offset + 8));
            offset += 12 + image.bytes.readUInt32BE(offset);
          }
          assert.ok(chunks.every((type) => ['IHDR', 'IDAT', 'IEND'].includes(type)));
        }
        assert.deepEqual((await socket(f, `${filePath(reference.id)}/download`, viewer)).bytes, source);
      }
      assert.equal((await upload(f, path, editor, revision, png.subarray(0, 20), 'truncated.png')).data.error.code, 'INVALID_IMAGE');
      const unavailable = fixtureId(5000);
      const avatarPng = await readFile(new URL('sample.png', formats));
      await f.insert('attachments', unavailable, { cardId: ids.activeCard, name: 'Unavailable imported', kind: 'file',
        availability: 'unavailable', blobDigest: checksum(avatarPng), byteLength: avatarPng.length });
      assert.equal((await socket(f, `${filePath(unavailable)}/download`, viewer)).status, 404);
      assert.equal((await f.call(cardPath(ids.activeCard), editor)).data.data.attachments.find(({ id }) => id === unavailable).available, false);
      const avatar = await upload(f, '/api/v1/me/avatar', editor, 1, avatarPng, 'avatar.png', { method: 'PUT' });
      assert.equal(avatar.status, 200, JSON.stringify(avatar.data));
      assert.equal((await socket(f, '/api/v1/me/avatar', editor)).status, 200);
      assert.equal((await socket(f, `/api/v1/users/${ids.firstEditor}/avatar?boardId=${ids.privateBoard}`, viewer)).status, 200);
      assert.equal((await socket(f, `/api/v1/users/${ids.firstEditor}/avatar?boardId=${ids.sharedBoard}`, viewer)).status, 404);
      const project = `/api/v1/projects/${ids.privateProject}`;
      assert.equal((await upload(f, `${project}/backgrounds`, owner, 1, Buffer.from('not an image'), 'old.txt')).status, 415);
      const background = await upload(f, `${project}/backgrounds`, owner, 1, avatarPng, 'background.png');
      assert.equal(background.status, 201, JSON.stringify(background.data));
      const bgId = background.data.data.reference.id;
      const preview = `${project}/backgrounds/${bgId}/thumbnail/small`;
      assert.equal((await socket(f, preview, owner)).status, 200);
      assert.equal((await socket(f, preview, viewer)).status, 404);
      assert.equal((await socket(f, `/api/v1/projects/${ids.sharedProject}/backgrounds/${bgId}/thumbnail/small`, editor)).status, 404);
      const available = (await f.call(project, owner)).data.data;
      assert.deepEqual(available.backgrounds.map(({ id }) => id), [bgId]);
      assert.equal(available.background, null);
      const sharedManager = await login(f, ids.projectManager);
      const crossProject = await f.call(`/api/v1/projects/${ids.sharedProject}`, sharedManager, {
        method: 'PATCH', headers: expected(sharedManager, 1), body: { background: { kind: 'image', id: bgId } },
      });
      assert.equal(crossProject.status, 422);
      assert.equal(crossProject.data.error.code, 'INVALID_PROJECT_BACKGROUND');
      const choose = await f.call(project, owner, {
        method: 'PATCH', headers: expected(owner, 2), body: { background: { kind: 'image', id: bgId } },
      });
      assert.equal(choose.status, 200);
      const chosen = (await f.call(project, viewer)).data.data;
      assert.deepEqual(chosen.background, { kind: 'image', id: bgId });
      assert.equal(chosen.backgrounds, null);
      assert.equal((await socket(f, preview, viewer)).status, 200);
      const outsider = await login(f, ids.admin);
      assert.equal((await socket(f, preview, outsider, { method: 'HEAD' })).status, 404);
      assert.equal((await f.call(`${project}/backgrounds/${bgId}`, owner, { method: 'DELETE', headers: expected(owner, 3) })).status, 204);
      assert.equal((await f.call(project, viewer)).data.data.background, null);
      assert.equal((await socket(f, preview, viewer)).status, 404);

      const remove = await f.call(filePath(cover), editor, { method: 'DELETE', headers: expected(editor, 1) });
      assert.equal(remove.status, 204);
      assert.equal((await f.call(cardPath(ids.activeCard), editor)).data.data.coverAttachmentId, null);
      const refs = await f.db.collection('blobs').find({ generationId: f.generationId }).toArray();
      assert.equal(refs.filter((row) => row.digest === checksum(avatarPng)).length, 1);
      await f.gate.runCommand(() => verifyActiveMedia(f.db, f.installationId, store));
    });
  });

test('orphan reconciliation retains newly unreachable old content, staged generations and volatile pins', { timeout: 100_000 }, async () => {
  await withMedia(async (f, { store, blobPath }) => {
    const editor = await login(f, ids.firstEditor);
    const bytes = Buffer.from('long-held attachment');
    const uploaded = await upload(f, `${cardPath(ids.activeCard)}/attachment-files`, editor, 1, bytes, 'old.dat');
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    const id = uploaded.data.data.reference.id;
    const path = join(blobPath, checksum(bytes));
    await utimes(path, new Date('2024-01-01'), new Date('2024-01-01'));
    const now = new Date();
    const sweep = (ms = 0) => f.gate.runCommand(() => sweepPrivateMedia(f.db, store, new Date(now.getTime() + ms), 128));
    await sweep();
    assert.ok(await stat(path));
    assert.equal((await f.call(filePath(id), editor, { method: 'DELETE', headers: expected(editor, 1) })).status, 204);
    await sweep();
    await sweep(mediaOrphanGraceMs - 1000);
    assert.ok(await stat(path));
    await sweep(mediaOrphanGraceMs + 1000);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.equal(await f.db.collection('blobs').countDocuments({ digest: checksum(bytes) }), 0);

    const signal = new AbortController().signal;
    async function publish(data) {
      const stage = await store.stage();
      try {
        const { identity } = await stage.receive(Readable.from([Buffer.from(data)]), 1024, signal);
        const unpin = await stage.publish([{ part: 'original', identity }]);
        return { identity, unpin, path: join(blobPath, identity.digest) };
      } finally { await stage.dispose(); }
    }
    const staged = await publish('generation 2');
    const inFlight = await publish('in flight');
    const prepared = await publish('prepared inactive');
    staged.unpin();
    prepared.unpin();
    await f.insert('attachments', id, { cardId: ids.activeCard, kind: 'file', name: 'Staged copy',
      availability: 'available', blobDigest: staged.identity.digest, byteLength: staged.identity.byteLength }, f.stagedGenerationId);
    await f.db.collection('installation').updateOne({ _id: 'installation' }, { $set: { activeGenerationId: f.stagedGenerationId } });
    const operationId = 'media.testPending';
    const journal = new CommandJournal(f.gate, f.db, f.installationId, { operations: { [operationId]: {
      normalize: () => ({}), authorize: () => {}, plan: () => ({ result: {}, effects: [{ kind: 'insert', collection: 'attachments', id: randomUUID(),
        fields: { cardId: ids.activeCard, name: 'Prepared', kind: 'file', availability: 'available', blobDigest: prepared.identity.digest } }],
      audit: { resourceType: 'card', resourceId: ids.activeCard, action: operationId, origin: 'web' } }),
    } }, checkpoint(point) { if (point === 'prepared') throw new Error('simulated process loss'); } });
    await assert.rejects(journal.execute({ actorId: ids.firstEditor, operationId, idempotencyKey: randomUUID(), input: null }));
    assert.equal(f.gate.ready, false);
    await f.db.collection('installation').updateOne({ _id: 'installation' }, { $set: { activeGenerationId: f.generationId } });
    await new CommandJournal(f.gate, f.db, f.installationId).recover();
    await sweep(2 * mediaOrphanGraceMs);
    await sweep(3 * mediaOrphanGraceMs + 1000);
    for (const object of [staged, inFlight, prepared]) assert.ok(await stat(object.path));
    inFlight.unpin();
  });
});

test('enforces exact 32 MiB bounds and disposes an aborted or corrupt stage', { timeout: 100_000 }, async () => {
  await withMedia(async (f, { store, stagePath, blobPath }) => {
    const editor = await login(f, ids.firstEditor);
    const path = `${cardPath(ids.activeCard)}/attachment-files`;
    const full = Buffer.alloc(maximumMediaBytes, 0x61);
    const accepted = await upload(f, path, editor, 1, full, 'exact.bin');
    assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    assert.equal(accepted.data.data.reference.byteLength, maximumMediaBytes);
    const oversized = await upload(f, path, editor, 2, Buffer.concat([full, Buffer.from('b')]), 'over.bin', { declared: maximumMediaBytes });
    assert.equal(oversized.status, 413, JSON.stringify(oversized.data));
    assert.deepEqual(await readdir(stagePath), []);
    assert.deepEqual(await readdir(blobPath), [checksum(full)]);

    const pending = form(Buffer.from('interrupted'), 'abort.bin');
    await new Promise((resolve, reject) => {
      const client = request({ socketPath: f.socketPath, path, method: 'POST', headers: {
        ...proxyHeaders(origin), Cookie: editor, ...pending.headers, ...expected(editor, 2),
      } });
      client.on('response', (response) => { response.resume(); reject(new Error('The incomplete body was answered early.')); });
      client.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
      client.write(pending.body[0]);
      const ceiling = Date.now() + 5000;
      const timer = setInterval(async () => {
        try {
          if ((await readdir(stagePath)).length > 0) {
            clearInterval(timer);
            client.destroy();
            resolve();
          } else if (Date.now() > ceiling) {
            clearInterval(timer);
            client.destroy();
            reject(new Error('The upload did not create its staging directory.'));
          }
        } catch (error) { clearInterval(timer); client.destroy(); reject(error); }
      }, 50);
    });
    for (let attempt = 0; attempt < 30 && (await readdir(stagePath)).length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await readdir(stagePath), []);
    assert.equal((await f.call(cardPath(ids.activeCard), editor)).data.data.revision, 2);

    const download = `${filePath(accepted.data.data.reference.id)}/download`;
    await new Promise((resolve, reject) => {
      const client = request({ socketPath: f.socketPath, path: download, headers: { ...proxyHeaders(origin), Cookie: editor } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error('The large download did not start.')); return; }
        response.once('data', () => { response.destroy(); resolve(); });
      });
      client.on('error', reject).end();
    });
    const target = join(blobPath, checksum(full));
    async function openBlobDescriptors() {
      return (await Promise.all((await readdir('/proc/self/fd')).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => null))))
        .filter((name) => name === target).length;
    }
    for (let attempt = 0; attempt < 30 && await openBlobDescriptors(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await openBlobDescriptors(), 0);

    const stage = await store.stage();
    try {
      const { identity } = await stage.receive(Readable.from([Buffer.from('abc')]), 1024, new AbortController().signal);
      const [directory] = await readdir(stagePath);
      const stored = join(stagePath, directory, 'original');
      await chmod(stored, 0o600);
      await writeFile(stored, 'xyz');
      await chmod(stored, 0o400);
      await assert.rejects(stage.publish([{ part: 'original', identity }]), { message: 'Private media storage is unavailable or inconsistent.' });
      assert.deepEqual(await readdir(blobPath), [checksum(full)]);
    } finally { await stage.dispose(); }
  });
});

test('permission downgrade during decode is enforced at commit',
  { timeout: 100_000, skip: !decoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async () => {
    const { readFile } = await import('node:fs/promises');
    const started = Promise.withResolvers();
    const decision = Promise.withResolvers();
    await withMedia(async (f, { stagePath }) => {
      const editor = await login(f, ids.firstEditor);
      const path = `${cardPath(ids.activeCard)}/attachment-files`;
      const uploadInFlight = upload(f, path, editor, 1, await readFile(new URL('sample.png', formats)), 'rechecked.png');
      try {
        await started.promise;
        await f.gate.runCommand(() => f.db.collection('boardMembers').updateOne({ generationId: f.generationId,
          boardId: ids.privateBoard, userId: ids.firstEditor }, { $set: { role: 'viewer', canComment: false } }));
      } finally { decision.resolve(); }
      const denied = await uploadInFlight;
      assert.equal(denied.status, 403, JSON.stringify(denied.data));
      assert.equal(await f.db.collection('blobs').countDocuments({ generationId: f.generationId }), 0);
      assert.equal((await f.call(cardPath(ids.activeCard), editor)).data.data.revision, 1);
      assert.deepEqual(await readdir(stagePath), []);
    }, { decoder: (decode) => async (...args) => { started.resolve(); await decision.promise; return decode(...args); } });
  });

test('published bytes survive interrupted journal effects and readiness opens after reconciliation', { timeout: 100_000 }, async () => {
  let interrupt = true;
  await withMedia(async (f, { store, stagePath }) => {
    const editor = await login(f, ids.firstEditor);
    const file = Buffer.from('published before the interrupted command');
    const path = `${cardPath(ids.activeCard)}/attachment-files`;
    const key = randomUUID();
    const interrupted = await upload(f, path, editor, 1, file, 'interrupted.bin', { key });
    assert.equal(interrupted.status, 503);
    assert.equal(f.gate.ready, false);
    assert.deepEqual(await readdir(stagePath), []);
    assert.equal(await f.db.collection('attachments').countDocuments({ generationId: f.generationId }), 0);
    await store.verifyBlob({ digest: checksum(file), byteLength: file.length });
    await new CommandJournal(f.gate, f.db, f.installationId).recover(() => verifyActiveMedia(f.db, f.installationId, store));
    assert.equal(f.gate.ready, true);
    const replay = await upload(f, path, editor, 1, file, 'interrupted.bin', { key });
    assert.equal(replay.status, 201, JSON.stringify(replay.data));
    const { reference } = replay.data.data;
    assert.deepEqual((await socket(f, `${filePath(reference.id)}/download`, editor)).bytes, file);
    assert.equal(await f.db.collection('attachments').countDocuments({ generationId: f.generationId }), 1);
  }, { checkpoint(point, step) {
    if (interrupt && point === 'effectApplied' && step === 0) { interrupt = false; throw new Error('test interruption'); }
  } });
});

test('catalog reuse replaces missing orphan variants but rejects missing referenced variants',
  { timeout: 100_000, skip: !decoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async () => {
    const { readFile } = await import('node:fs/promises');
    await withMedia(async (f) => {
      const editor = await login(f, ids.firstEditor);
      const file = await readFile(new URL('sample.png', formats));
      const digest = checksum(file);
      const legacy = { digest: checksum(Buffer.from('previous rendition')), byteLength: 18 };
      const catalogId = fixtureId(5600);
      await f.insert('blobs', catalogId, { digest, byteLength: file.length, mimeType: 'image/png',
        lifecycleState: 'available', variants: { small: legacy, large: legacy } });
      const path = `${cardPath(ids.activeCard)}/attachment-files`;
      const inserted = await upload(f, path, editor, 1, file, 'fresh.png');
      assert.equal(inserted.status, 201, JSON.stringify(inserted.data));
      const catalog = await f.db.collection('blobs').findOne({ generationId: f.generationId, id: catalogId });
      assert.notEqual(catalog.variants.small.digest, legacy.digest);
      assert.notEqual(catalog.variants.large.digest, legacy.digest);
      const id = inserted.data.data.reference.id;
      assert.equal((await socket(f, `${filePath(id)}/thumbnail/small`, editor)).status, 200);
      await f.db.collection('blobs').updateOne({ _id: catalog._id }, { $set: { 'variants.small': legacy } });
      assert.equal((await upload(f, path, editor, 2, file, 'should-not-attach.png')).status, 503);
      assert.equal(f.gate.ready, false);
      assert.equal(await f.db.collection('attachments').countDocuments({ generationId: f.generationId }), 1);
    });
  });

test('deleting a board removes only its attachment references and preserves shared file bytes', { timeout: 100_000 }, async () => {
  await withMedia(async (f, { blobPath }) => {
    const editor = await login(f, ids.firstEditor);
    const owner = await login(f, ids.privateOwner);
    const bytes = Buffer.from([0x41, 0x80, 0x65, 0x02, 0xff]);
    const lost = await upload(f, cardPath(ids.activeCard) + '/attachment-files', editor, 1, bytes, 'Private board file');
    const retained = await upload(f, cardPath(ids.sharedTarget) + '/attachment-files', editor, 1, bytes, 'Surviving board file');
    assert.equal(lost.status, 201);
    assert.equal(retained.status, 201);
    const lostPath = filePath(lost.data.data.reference.id) + '/download';
    const retainedPath = filePath(retained.data.data.reference.id) + '/download';
    assert.deepEqual((await socket(f, lostPath, editor)).bytes, bytes);
    const deleted = await f.call('/api/v1/boards/' + ids.privateBoard, owner, {
      method: 'DELETE', headers: expected(owner, 1), body: { name: 'Transfer source' },
    });
    assert.equal(deleted.status, 204, JSON.stringify(deleted.data));
    assert.equal((await socket(f, lostPath, editor)).status, 404);
    assert.equal((await socket(f, lostPath, owner, { method: 'HEAD' })).status, 404);
    assert.deepEqual((await socket(f, retainedPath, editor)).bytes, bytes);
    assert.deepEqual(await readdir(blobPath), [checksum(bytes)]);
    assert.equal(await f.db.collection('attachments').countDocuments({ ...f.scope, blobDigest: checksum(bytes) }), 1);
    assert.equal(await f.db.collection('blobs').countDocuments({ digest: checksum(bytes) }), 1);
  });
});

test('historical cards retain authenticated exact file bytes while ordinary mutations are denied', { timeout: 100_000 }, async () => {
  await withMedia(async (f) => {
    const editor = await login(f, ids.firstEditor);
    const viewer = await login(f, ids.viewer);
    const outsider = await login(f, ids.unrelated);
    const card = cardPath(ids.activeCard);
    const original = Buffer.from([0x00, 0x7f, 0xfe, 0x41]);
    const created = await upload(f, card + '/attachment-files', editor, 1, original, 'historical.dat');
    assert.equal(created.status, 201);
    const ref = filePath(created.data.data.reference.id);
    const archive = await f.call(card + '/archive', editor, { method: 'POST', headers: expected(editor, 2),
      body: { sourceOrderVersion: 1, destinationOrderVersion: 1 } });
    assert.equal(archive.status, 200, JSON.stringify(archive.data));
    assert.equal((await f.call(card, viewer)).data.data.attachments[0].available, true);
    const full = await socket(f, ref + '/download', viewer);
    assert.deepEqual([full.status, full.bytes], [200, original]);
    assert.equal((await socket(f, ref + '/download', outsider, { method: 'HEAD', headers: { Range: 'bytes=0-1', 'If-None-Match': '*' } })).status, 404);
    assert.equal((await f.call(ref, editor, { method: 'PATCH', headers: expected(editor, 1), body: { name: 'Historical edit' } })).status, 403);
    const restore = await f.call(card + '/restore', editor, { method: 'POST', headers: expected(editor, 3),
      body: { sourceOrderVersion: 2, destinationOrderVersion: 2 } });
    assert.equal(restore.status, 200, JSON.stringify(restore.data));
    assert.equal((await f.call(ref, editor, { method: 'PATCH', headers: expected(editor, 1), body: { name: 'Restored file' } })).status, 200);
  });
});

test('clearing trash retires only deleted logical attachment references while shared bytes are still served', { timeout: 100_000 }, async () => {
  await withMedia(async (f, { blobPath }) => {
    const editor = await login(f, ids.firstEditor);
    const bytes = Buffer.from([0xaa, 0x00, 0xfd, 0x3c, 0x42]);
    const removed = await upload(f, cardPath(ids.activeCard) + '/attachment-files', editor, 1, bytes, 'Trash file');
    const survivor = await upload(f, cardPath(ids.sharedTarget) + '/attachment-files', editor, 1, bytes, 'Live file');
    assert.equal(removed.status, 201);
    assert.equal(survivor.status, 201);
    const removedPath = filePath(removed.data.data.reference.id) + '/download';
    const retainedPath = filePath(survivor.data.data.reference.id) + '/download';
    const trashed = await f.call(cardPath(ids.activeCard) + '/trash', editor, {
      method: 'POST', headers: expected(editor, removed.data.data.parent.revision),
      body: { sourceOrderVersion: 1, destinationOrderVersion: 1 },
    });
    assert.equal(trashed.status, 200);
    assert.deepEqual((await socket(f, removedPath, editor)).bytes, bytes);
    const { destination } = trashed.data.data;
    const clear = await f.call('/api/v1/boards/' + ids.privateBoard + '/trash/clear', editor, {
      method: 'POST', headers: expected(editor, destination.revision),
      body: { trashListId: destination.listId, trashOrderVersion: destination.orderVersion, confirmed: true },
    });
    assert.equal(clear.status, 200);
    assert.equal(clear.data.data.clearedCount, 2);
    assert.equal((await socket(f, removedPath, editor)).status, 404);
    assert.deepEqual((await socket(f, retainedPath, editor)).bytes, bytes);
    assert.deepEqual(await readdir(blobPath), [checksum(bytes)]);
    assert.equal(await f.db.collection('attachments').countDocuments({ ...f.scope, blobDigest: checksum(bytes) }), 1);
  });
});
