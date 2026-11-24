import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Binary, Double, Int32, Long } from 'mongodb';
import { archiveRows, digestRawRows } from '../../apps/backend/dist/application/backup/records.js';
import { createBackup } from '../../apps/backend/dist/application/backup/capture.js';
import { inspectBackup, stageRestore, activateRestore } from '../../apps/backend/dist/application/backup/restore.js';
import { openRestoreMedia } from '../../apps/backend/dist/application/backup/restore-media.js';
import { createPasswordHasher } from '../../apps/backend/dist/application/auth/password.js';
import { readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { createBrowserSessions } from '../../apps/backend/dist/application/auth/sessions.js';
import { CommandGate } from '../../apps/backend/dist/application/command-gate/gate.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';
import { workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { password } from '../support/account-fixture.mjs';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture } from '../support/workspace-access-fixture.mjs';

assertOwnedMongoEnvironment(process.env);
const owner = { uid: process.getuid(), gid: process.getgid() };
const digest = (data) => createHash('sha256').update(data).digest('hex');

async function scratch(run) {
  const root = await mkdtemp(join(homedir(), '.planner-backup-fixture-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function dirs(root, name) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  const paths = { staging: join(directory, 'staging'), blobs: join(directory, 'blobs'), backups: join(directory, 'backups'), writer: join(directory, 'writer') };
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
  await chmod(paths.writer, 0o750);
  return paths;
}

async function mediaObject(store, source) {
  const stage = await store.stage();
  try {
    const { identity } = await stage.receive(Readable.from([source]), 1024, new AbortController().signal);
    const release = await stage.publish([{ part: 'original', identity }]);
    release();
    return identity;
  } finally { await stage.dispose(); }
}

async function sourceFixture(root, mongo) {
  const f = await makeWorkspaceAccessFixture(mongo);
  const src = await dirs(root, 'source');
  const store = await createPrivateMediaStore(src.staging, src.blobs);
  const key = randomBytes(32);
  await f.db.collection('installation').updateOne({ _id: 'installation' }, { $set: { mfaKeyDigest: digest(key) } });
  const config = { formatVersion: 1, installationId: f.installationId, mode: 'fresh', publicUrl: 'https://source.example.test', appPort: 27430, dbPort: 27431 };
  const activeBytes = Buffer.from('private signed workspace asset');
  const active = await mediaObject(store, activeBytes);
  const staged = await mediaObject(store, Buffer.from('other generation asset'));
  const variant = await mediaObject(store, Buffer.from('test fixture rendition'));
  for (const [generationId, identity] of [[f.generationId, active], [f.stagedGenerationId, staged]]) {
    await f.insert('blobs', fixtureId(8000), { ...identity, mimeType: 'image/png', lifecycleState: 'available',
      variants: { small: variant, large: variant } }, generationId);
    await f.insert('attachments', fixtureId(8001), { cardId: ids.activeCard, kind: 'file', name: 'Private attachment',
      blobDigest: identity.digest, byteLength: identity.byteLength, availability: 'available' }, generationId);
  }
  await f.db.collection('cards').updateOne({ _id: workspaceKey(f.generationId, ids.activeCard) }, {
    $set: { privateBsonFixture: { wide: Long.fromBigInt(9223372036854775807n), int: new Int32(7),
      double: new Double(7), binary: new Binary(Buffer.from([0, 0xff]), Binary.SUBTYPE_USER_DEFINED) } },
  });
  const login = await f.login(ids.admin);
  assert.equal(login.status, 200);
  assert.ok(cookieOf(login));
  for (const [index, collection] of ['trustedDevices', 'recoveryGrants', 'oauthArtifacts', 'oauthConnections'].entries()) {
    const id = fixtureId(8100 + index);
    await f.db.collection(collection).insertOne({ _id: workspaceKey(f.generationId, id), generationId: f.generationId, id,
      kind: 'fixture', artifactId: id, clientId: 'native fixture', userId: ids.admin, tokenDigest: digest(Buffer.from(id)),
      providerGrantId: id, revokedAt: null, embeddedSecret: { token: 'fixture only' } });
  }
  const backup = (files = store) => createBackup(f.gate, f.db, config, key, files, src.backups, owner);
  return { f, src, store, key, backup, active, staged, variant, activeBytes, cookie: cookieOf(login), async close() {
    key.fill(0);
    await f.close();
    await store.close();
  } };
}

async function crashAt(targetMongo, target, archive, fingerprint, point) {
  const child = fork(fileURLToPath(new URL('../support/native-backup-crash.mjs', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const result = await new Promise((resolve, reject) => {
    let receipt;
    child.once('error', reject);
    child.once('message', (message) => { receipt = message; child.kill('SIGKILL'); });
    child.once('exit', (code, signal) => {
      if (signal === 'SIGKILL' && receipt?.point === point) resolve(receipt);
      else reject(new Error(`The owned restore child failed before its ${point} checkpoint (${code ?? signal}).`));
    });
    const { username, password } = targetMongo.client.options.credentials;
    child.send({ target, archive, fingerprint, point, auth: { username, password },
      socketPath: targetMongo.socketPath, database: targetMongo.db.databaseName });
  });
  return result.id;
}

test('captures matched BSON and all-generation pinned media, then replays durable restore and activation', { timeout: 100_000 }, async () => {
  await scratch((root) => withFixtureMongo(async (sourceMongo) => {
    const source = await sourceFixture(root, sourceMongo);
    const { f, store } = source;
    try {
      const slow = Promise.withResolvers();
      const copying = Promise.withResolvers();
      const capture = source.backup({ ...store, async openBlob(identity) {
        copying.resolve();
        await slow.promise;
        return store.openBlob(identity);
      } });
      try {
        await Promise.race([copying.promise, capture.then(() => { throw new Error('The capture skipped the pinned media.'); })]);
        assert.ok(store.isPinned(source.active.digest));
        assert.ok(store.isPinned(source.staged.digest));
        await f.gate.runCommand(() => f.db.collection('cards').updateOne({ _id: workspaceKey(f.generationId, ids.activeCard) },
          { $set: { name: 'Mutation after snapshot' } }));
      } finally { slow.resolve(); }
      const receipt = await capture;
      assert.equal(store.isPinned(source.active.digest), false);
      const path = join(source.src.backups, receipt.backupId);
      assert.equal((await lstat(path)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(path, 'secrets.json'))).mode & 0o777, 0o600);
      assert.equal(digest(await readFile(join(path, 'manifest.json'))), receipt.manifestSha256);
      await assert.rejects(inspectBackup(path, owner, 'a'.repeat(64)), /expected Planner backup manifest/);
      const backup = await inspectBackup(path, owner, receipt.manifestSha256);
      try {
        const names = backup.archive.manifest.collections.map(({ name }) => name);
        assert.deepEqual(names, names.slice().sort());
        assert.deepEqual(backup.archive.manifest.blobs.map(({ sha256 }) => sha256), [source.active.digest, source.staged.digest, source.variant.digest].sort());
        const part = backup.archive.manifest.collections.find(({ name }) => name === 'cards');
        const file = await backup.archive.collection(part);
        try {
          for await (const { id, record } of archiveRows(file, part)) {
            if (id !== workspaceKey(f.generationId, ids.activeCard)) continue;
            assert.notEqual(record.name, 'Mutation after snapshot');
            assert.equal(record.privateBsonFixture.wide.toBigInt(), 9223372036854775807n);
            assert.equal(record.privateBsonFixture.int._bsontype, 'Int32');
            assert.equal(record.privateBsonFixture.double._bsontype, 'Double');
            assert.equal(record.privateBsonFixture.binary.sub_type, Binary.SUBTYPE_USER_DEFINED);
          }
        } finally { await file.close(); }

        await withFixtureMongo(async (targetMongo) => {
          const { db } = targetMongo;
          const target = await dirs(root, 'target');
          await db.collection('installation').insertOne({ _id: 'installation', installationId: f.installationId });
          const writer = () => acquireWriterDirectory(target.writer, owner, owner);
          const verifyKey = (expected) => assert.equal(digest(backup.key), expected);
          async function offline(run) {
            const lease = writer();
            assert.throws(writer);
            const media = await openRestoreMedia({ ...target, owner, fingerprint: receipt.manifestSha256 });
            try { return await run(lease, media); } finally { await media.close(); lease.release(); }
          }
          const activate = (lease, media, checkpoint) => activateRestore(db, lease, media, f.installationId,
            receipt.manifestSha256, backup.proof, verifyKey, checkpoint);
          const checkpoint = (point) => crashAt(targetMongo, target, path, receipt.manifestSha256, point);
          const firstRow = await checkpoint('row');
          assert.equal((await db.collection('installation').findOne()).activeGenerationId, null);
          await assert.rejects(offline(activate), /matching verified staged backup/);
          const boundary = firstRow.indexOf('/');
          const name = firstRow.slice(0, boundary);
          const id = firstRow.slice(boundary + 1);
          assert.equal((await db.collection(name).updateOne({ _id: id }, { $set: { conflictingField: true } })).matchedCount, 1);
          await assert.rejects(offline((lease, media) => stageRestore(db, lease, media, backup)), /conflicts with the backup/);
          await db.collection(name).updateOne({ _id: id }, { $unset: { conflictingField: '' } });
          await checkpoint('blob');
          assert.equal((await db.collection('installation').findOne()).activeGenerationId, null);
          assert.equal((await offline((lease, media) => stageRestore(db, lease, media, backup))).state, 'staged');
          assert.equal((await offline((lease, media) => stageRestore(db, lease, media, backup))).state, 'staged');
          await assert.rejects(offline((lease, media) => activateRestore(db, lease, media, f.installationId,
            receipt.manifestSha256, '0'.repeat(64), verifyKey)), /matching verified staged backup/);
          const stagedCard = await db.collection('cards').findOne({ _id: workspaceKey(f.generationId, ids.activeCard) }, { promoteValues: false });
          assert.notEqual(stagedCard.name, 'Mutation after snapshot');
          assert.deepEqual(await digestRawRows(db, 'cards'), backup.inventory.find(({ name }) => name === 'cards'));
          assert.equal(await db.collection('sessions').countDocuments(), 0);
          assert.equal(await db.collection('trustedDevices').countDocuments(), 0);
          assert.equal(await db.collection('recoveryGrants').countDocuments(), 0);
          assert.equal(await db.collection('oauthArtifacts').countDocuments(), 0);
          const connection = await db.collection('oauthConnections').findOne();
          assert.equal(connection.providerGrantId, fixtureId(8103));
          assert.equal(connection.tokenDigest, undefined);
          assert.equal(connection.embeddedSecret, undefined);
          assert.ok(connection.revokedAt instanceof Date);
          const live = join(target.blobs, source.active.digest);
          assert.deepEqual(await readFile(live), source.activeBytes);
          assert.equal((await lstat(live)).mode & 0o777, 0o400);
          await unlink(live);
          await assert.rejects(offline(activate));
          assert.equal((await db.collection('installation').findOne()).activeGenerationId, null);
          assert.equal((await offline((lease, media) => stageRestore(db, lease, media, backup))).state, 'staged');
          await checkpoint('activated');
          assert.equal((await db.collection('installation').findOne()).activeGenerationId, f.generationId);
          await unlink(live);
          await assert.rejects(offline((lease, media) => activateRestore(db, lease, media, f.installationId,
            receipt.manifestSha256, backup.proof, verifyKey, undefined, true)));
          await offline(async (_lease, media) => {
            const entry = backup.archive.manifest.blobs.find(({ sha256 }) => sha256 === source.active.digest);
            const file = await backup.archive.blob(entry);
            try { await media.writeBlob(file, entry); } finally { await file.close(); }
          });
          assert.equal((await offline((lease, media) => activateRestore(db, lease, media, f.installationId,
            receipt.manifestSha256, backup.proof, verifyKey, undefined, true))).state, 'active');
          assert.equal((await offline(activate)).state, 'active');
          await assert.rejects(offline((lease, media) => stageRestore(db, lease, media, backup)), /replace an active/);
          const gate = new CommandGate(writer());
          try {
            await gate.recover(() => {});
            const sessions = createBrowserSessions(db, f.installationId, gate, createPasswordHasher());
            assert.equal(await sessions.read(readSessionCookie(source.cookie)), null);
            const login = await sessions.login({ identifier: 'admin@planner.invalid', password });
            assert.equal(login.status, 'authenticated');
            assert.equal(login.session.account.id, ids.admin);
          } finally { await gate.closeAndDrain(); }
        });
      } finally { await backup.close(); }
    } finally { await source.close(); }
  }));
});

test('refuses substituted BSON parts, symlinks and foreign source data without deleting the source', { timeout: 100_000 }, async () => {
  await scratch((root) => withFixtureMongo(async (mongo) => {
    const source = await sourceFixture(root, mongo);
    try {
      await chmod(join(root, 'source'), 0o100);
      const receipt = await source.backup();
      const path = join(source.src.backups, receipt.backupId);
      const copy = join(root, 'copied');
      await cp(path, copy, { recursive: true });
      const cards = join(copy, 'db', 'cards.bson');
      const bytes = await readFile(cards);
      const changed = Buffer.from(bytes);
      changed[changed.length - 2] ^= 1;
      await writeFile(cards, changed);
      await assert.rejects(inspectBackup(copy, owner, receipt.manifestSha256), /checksum/);
      await unlink(cards);
      await symlink(join(path, 'db', 'cards.bson'), cards);
      await assert.rejects(inspectBackup(copy, owner, receipt.manifestSha256));
      assert.deepEqual(await readFile(join(path, 'db', 'cards.bson')), bytes);
      await source.f.db.collection('foreignFixture').insertOne({ ownedElsewhere: true });
      await assert.rejects(source.backup(), /unrecognized collection/);
      assert.equal(await source.f.db.collection('foreignFixture').countDocuments(), 1);
      assert.equal(source.f.gate.ready, true);
    } finally {
      await chmod(join(root, 'source'), 0o700);
      await source.close();
    }
  }));
});
