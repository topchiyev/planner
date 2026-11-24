import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { inspectDirectory, inspectObjects, parseObjectService, reconcileAssets } from '../../apps/backend/dist/application/migration/assets.js';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { durable } from '../../apps/backend/dist/application/command-journal/records.js';
import { importRunKey, migrationCursors, writeMigrationBatch } from '../../apps/backend/dist/application/migration/checkpoint.js';
import { MigrationError, assetKeyKind, readAssetManifest, readCaptureManifest, sha256 } from '../../apps/backend/dist/application/migration/manifest.js';
import { compareSourceHistory, compareSourcePosition, SourceJsonNumber } from '../../apps/backend/dist/application/migration/source-projections.js';
import { inspectMigration, withMigrationSnapshot } from '../../apps/backend/dist/application/migration/preflight.js';
import { parseSourceService } from '../../apps/backend/dist/application/migration/source-service.js';
import { sourceColumns } from '../../apps/backend/dist/application/migration/source-catalog.js';
import { prepareMigration } from '../../apps/backend/dist/application/migration/prepare.js';
import { anchoredDirectory } from '../../apps/backend/dist/application/backup/archive.js';
import { assertMigrationCapacity, persistMigrationPreflight } from '../../apps/backend/dist/native/migration-state.js';
import { legacyPublicId, workspaceKey } from '../../apps/backend/dist/storage/identity.js';
import { migrateStorageSchema } from '../../apps/backend/dist/storage/schema.js';
import { withFixtureMongo } from '../support/fixture-mongo.ts';
import { startFixturePostgres } from '../fixtures/planka/private-postgres.mjs';
import { assembleSnapshot } from '../fixtures/planka/snapshot.mjs';

const synthetic = (release) => fileURLToPath(new URL('../fixtures/planka/' + release + '/', import.meta.url));
const owner = { uid: process.getuid(), gid: process.getgid() };
const refuses = (fault) => (error) => error?.fault === fault;

function part(name, bytes = Buffer.alloc(0), type = '0') {
  const header = Buffer.alloc(512);
  assert.ok(Buffer.byteLength(name) <= 100);
  header.write(name);
  header.write('0000600', 100);
  header.write('0000000', 108);
  header.write('0000000', 116);
  header.write(bytes.length.toString(8).padStart(11, '0'), 124);
  header.write('00000000000', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0' + '00', 257);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

async function localDirectory(t) {
  const directory = await mkdtemp(join(homedir(), '.planner-migration-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixtureBundle(release) {
  const source = synthetic(release);
  const manifest = await readFile(join(source, 'manifest.json'));
  const assetManifest = await readFile(join(source, 'asset-manifest.json'));
  const dump = Buffer.from(assembleSnapshot(release));
  const assets = JSON.parse(assetManifest).files;
  const entries = [
    part('manifest.json', manifest), part('asset-manifest.json', assetManifest), part('source.sql', dump),
    ...await Promise.all(assets.map(async ({ key }) => part('assets/' + key, await readFile(join(source, 'assets', key))))),
  ];
  return { entries, manifest, assetManifest, dump };
}

test('migration preparation verifies full archives before writing and cleanly aborts a live candidate', async (t) => {
  const root = await localDirectory(t);
  const work = join(root, 'work');
  await mkdir(work, { mode: 0o700 });
  const input = join(root, 'fixture.tar');
  const bundle = await fixtureBundle('2.3.0');
  await writeFile(input, gzipSync(tar(...bundle.entries)), { mode: 0o600 });
  const original = sha256(await readFile(input));
  const prepared = await prepareMigration(input, work, owner);
  assert.equal(sha256(await readFile(input)), original);
  assert.equal(prepared.manifestSha256, sha256(bundle.manifest));
  assert.deepEqual(await readFile(prepared.dump), bundle.dump);
  const before = await readdir(work);

  const unsafe = [
    [part('/escape', Buffer.from('outside')), 'asset-key'],
    [part('assets/../escape'), 'asset-key'],
    [part('assets/shortcut', Buffer.alloc(0), '2'), 'archive-layout'],
    [part('manifest.json', bundle.manifest), 'archive-layout'],
    [part('assets/private/attachments/9007199254741220/rÉseau Tile.png'), 'asset-key'],
    [part('assets/private/attachments/9007199254741220/Réseau Tile.png'), 'asset-key'],
  ];
  for (const [extra, expected] of unsafe) {
    await writeFile(input, tar(...bundle.entries, extra));
    await assert.rejects(prepareMigration(input, work, owner), refuses(expected));
    assert.deepEqual(await readdir(work), before);
  }
  const override = 'path=assets/../escape\n';
  const pax = Buffer.from(String(override.length + 3) + ' ' + override);
  await writeFile(input, tar(part('PaxHeader', pax, 'x'), part('source.sql', bundle.dump), ...bundle.entries));
  await assert.rejects(prepareMigration(input, work, owner), refuses('asset-key'));
  assert.deepEqual(await readdir(work), before);

  const large = Buffer.alloc(24 * 1024 * 1024, 97);
  const changedCapture = JSON.parse(bundle.manifest);
  changedCapture.source.dumpSha256 = sha256(large);
  await writeFile(input, tar(part('manifest.json', Buffer.from(JSON.stringify(changedCapture))),
    bundle.entries[1], part('source.sql', large), ...bundle.entries.slice(3)));
  const controller = new AbortController();
  const preparing = prepareMigration(input, work, owner, controller.signal);
  const disposition = assert.rejects(preparing);
  for (let count = 0; count < 10_000; count += 1) {
    if ((await readdir(work)).some((name) => name.startsWith('.capture-'))) {
      controller.abort();
      break;
    }
    await delay(1);
  }
  assert.equal(controller.signal.aborted, true);
  await disposition;
  assert.deepEqual(await readdir(work), before);
});

test('both synthetic restored tags match the native-source preflight through a true dedicated SELECT role', async (t) => {
  const root = await localDirectory(t);
  const postgres = await startFixturePostgres(t, root);
  const input = join(root, 'snapshot.tar');
  const work = join(root, 'work');
  await mkdir(work, { mode: 0o700 });
  postgres.write('postgres', 'ALTER ROLE fixture_reader NOINHERIT;');
  for (const [release, suffix] of [['2.3.0', '230'], ['2.3.1', '231']]) {
    const database = 'planka_preflight_' + suffix;
    postgres.createDatabase(database);
    postgres.write(database, assembleSnapshot(release));
    postgres.write(database, 'REVOKE TEMPORARY ON DATABASE ' + database + ' FROM PUBLIC;');
    for (const [table, columns] of Object.entries(sourceColumns)) {
      postgres.write(database, 'GRANT SELECT (' + columns.map((column) => '"' + column + '"').join(',') +
        ') ON TABLE public."' + table + '" TO fixture_reader;');
    }
    assert.equal(postgres.query(database,
      "SELECT pg_catalog.has_column_privilege('public.user_account', 'password', 'SELECT')"), 'f');
    assert.equal(postgres.query(database,
      "SELECT pg_catalog.has_column_privilege('public.session', 'access_token', 'SELECT')"), 'f');
    const config = ['[fixture]', 'host=' + postgres.socketRoot, 'port=' + postgres.port, 'dbname=' + database,
      'user=fixture_reader', 'isolated=true'].join('\n');
    const uncachedIdentity = new pg.Client(parseSourceService(config, 'fixture'));
    assert.equal(typeof uncachedIdentity.connectionParameters.password, 'function');
    assert.equal(await uncachedIdentity.connectionParameters.password(), '');
    const configuredIdentity = new pg.Client(parseSourceService(config + '\npassword=synthetic-fixture-only', 'fixture'));
    assert.equal(await configuredIdentity.connectionParameters.password(), 'synthetic-fixture-only');
    const bundle = await fixtureBundle(release);
    await writeFile(input, tar(...bundle.entries), { mode: 0o600 });
    const prepared = await prepareMigration(input, work, owner);
    const request = { manifest: prepared.manifest, sourceService: 'fixture', assetsRoot: prepared.assets };
    const accepted = await inspectMigration(request, owner, config);
    assert.equal(accepted.capture.source.release, release);
    assert.equal(accepted.restoredPostgresVersion.startsWith('17.'), true);
    assert.equal(Object.keys(accepted.rows).length, 34);
    assert.equal(accepted.rows.migration, '23');
    assert.deepEqual(accepted.assets, { present: 9, missingOriginals: 0, missingDerivatives: 0 });
    assert.equal(postgres.query(database, 'SELECT count(*) FROM public.card;'), '6');

    for (const batchSize of [1, 2, 256]) {
      const reading = await withMigrationSnapshot(request, owner, config, undefined,
        { batchSize, expectedFingerprint: accepted.fingerprint.sha256 }, async (snapshot) => {
          const output = {};
          for (const table of ['card', 'board_membership', 'uploaded_file', 'user_account']) {
            let last = null;
            output[table] = [];
            for (;;) {
              const batch = await snapshot.readBatch(table, last, batchSize);
              output[table].push(...batch.rows);
              if (!batch.hasMore) break;
              assert.notEqual(batch.lastSourceId, last);
              last = batch.lastSourceId;
            }
          }
          const lastPage = await snapshot.readBatch('card', '9007199254740996', 2);
          assert.deepEqual(lastPage.rows.map(({ id }) => id), ['9007199254740997', '9007199254740998']);
          assert.equal(lastPage.hasMore, false);
          assert.equal((await snapshot.readBatch('card', '9007199254740995', 2)).hasMore, true);
          return output;
        });
      assert.deepEqual(reading.fingerprint, accepted.fingerprint);
      assert.deepEqual(reading.value.card.slice(0, 3).map(({ id, position }) => [id, position]), [
        ['9007199254740993', 1024], ['9007199254740994', 1024], ['9007199254740995', 2048],
      ]);
      assert.deepEqual(reading.value.uploaded_file.map(({ id }) => id), [
        '03000000-0000-4000-8000-000000000001', '03000000-0000-4000-8000-000000000002',
        '9007199254741220', '9007199254741221', '9007199254741222',
      ]);
      assert.equal(reading.value.card[0].due_date, '2026-02-12T08:09:10.654321Z');
      assert.equal(reading.value.card[0].stopwatch.value.total.decimal, '0');
      assert.equal(reading.value.card[0].is_due_completed, false);
      assert.equal(reading.value.card[1].stopwatch, null);
      assert.equal(reading.value.card[1].is_due_completed, null);
      assert.deepEqual(reading.value.board_membership.map(({ can_comment }) => can_comment), [null, null, true, false, null]);
      assert.equal(reading.value.user_account[0].is_totp_enabled, true);
      assert.equal(Object.hasOwn(reading.value.user_account[0], 'password'), false);
      assert.equal(Object.hasOwn(reading.value.user_account[0], 'totp_secret'), false);
    }

    if (release !== '2.3.1') continue;
    const alias = await inspectMigration({ ...request, sourceService: 'fixture-alias' }, owner,
      config.replace('[fixture]', '[fixture-alias]'));
    assert.deepEqual(alias.fingerprint, accepted.fingerprint);
    const relocated = await mkdtemp(join(root, 'relocated-'));
    const relocatedManifest = join(relocated, 'manifest.json');
    await writeFile(relocatedManifest, JSON.stringify(JSON.parse(bundle.manifest)), { mode: 0o600 });
    await writeFile(join(relocated, 'asset-manifest.json'), bundle.assetManifest, { mode: 0o600 });
    await writeFile(join(relocated, 'source.sql'), bundle.dump, { mode: 0o600 });
    const copied = await inspectMigration({ ...request, manifest: relocatedManifest }, owner, config);
    assert.deepEqual(copied.fingerprint, accepted.fingerprint);
    assert.notEqual(copied.manifestSha256, accepted.manifestSha256);

    const noAdmission = () => assert.fail('Changed source admitted its old run');
    const before = accepted.fingerprint.sha256;
    const concurrent = await withMigrationSnapshot(request, owner, config, undefined,
      { expectedFingerprint: before }, async (snapshot) => {
        const first = (await snapshot.readBatch('card', null, 1)).rows[0];
        postgres.write(database, "UPDATE public.card SET created_at='2026-02-11 08:09:10.123458' WHERE id=9007199254740993");
        const stillOriginal = (await snapshot.readBatch('card', null, 1)).rows[0];
        assert.deepEqual(first, stillOriginal);
        return stillOriginal.created_at;
      });
    assert.equal(concurrent.value, '2026-02-11T08:09:10.123456Z');
    await assert.rejects(withMigrationSnapshot(request, owner, config, undefined, { expectedFingerprint: before }, noAdmission),
      refuses('source-changed'));
    assert.equal((await inspectMigration(request, owner, config)).rows.card, '6');
    postgres.write(database, "UPDATE public.card SET created_at='2026-02-11 08:09:10.123456' WHERE id=9007199254740993");
    assert.equal((await inspectMigration(request, owner, config)).fingerprint.sha256, before);

    postgres.write(database, "UPDATE public.user_account SET password='invented-unused-fixture-password' WHERE id=101");
    assert.equal((await inspectMigration(request, owner, config)).fingerprint.sha256, before);
    postgres.write(database, "UPDATE public.notification_service SET format='html' WHERE id=831");
    const html = await inspectMigration(request, owner, config);
    postgres.write(database, "UPDATE public.notification_service SET format='unknown fixture format' WHERE id=831");
    const unknownFormat = await inspectMigration(request, owner, config);
    assert.notEqual(html.fingerprint.components.rows, unknownFormat.fingerprint.components.rows);
    postgres.write(database, "UPDATE public.notification_service SET format='text' WHERE id=831");
    assert.equal((await inspectMigration(request, owner, config)).fingerprint.sha256, before);
    postgres.write(database, `
      INSERT INTO public.card (id, board_id, list_id, type, position, name, description, stopwatch, comments_total, is_closed)
        VALUES ('-9223372036854775808',301,401,'story',3.141592653589793,'edge','', 'null',0,false),
          ('-9007199254740993',301,401,'story',3.141592653589793,'edge','  Ω  ',NULL,0,false),
          ('0',301,401,'story',NULL,'edge',NULL,NULL,0,false),
          ('10',301,401,'story',1000,'edge',NULL,NULL,0,false),
          ('2',301,401,'story',1000,'edge',NULL,NULL,0,false),
          ('9223372036854775807',301,401,'story',NULL,'edge',NULL,NULL,0,false);
      INSERT INTO public.uploaded_file (id, type, size)
        VALUES ('-9223372036854775808','attachment',0),('0','attachment',0),('9223372036854775807','attachment',0);
      UPDATE public.action SET data = '{"card":{"id":9007199254740993},"sample":0.000000000000000001,"absentContrast":null,"flag":false,"empty":""}'
        WHERE id=712;
    `);
    const exact = await withMigrationSnapshot(request, owner, config, undefined, { batchSize: 2 }, async (snapshot) => {
      const cards = (await snapshot.readBatch('card', null, 256)).rows;
      assert.deepEqual(cards.map(({ id }) => id), [
        '-9223372036854775808', '-9007199254740993', '0', '2', '10', '9007199254740993', '9007199254740994',
        '9007199254740995', '9007199254740996', '9007199254740997', '9007199254740998', '9223372036854775807',
      ]);
      assert.deepEqual((await snapshot.readBatch('card', '-9007199254740993', 2)).rows.map(({ id }) => id), ['0', '2']);
      assert.deepEqual(cards.slice(0, 3).map(({ description, stopwatch }) => [description, stopwatch]),
        [['', { value: null }], ['  Ω  ', null], [null, null]]);
      assert.equal(cards[0].position, Math.PI);
      const uploads = (await snapshot.readBatch('uploaded_file', null, 3)).rows;
      assert.deepEqual(uploads.map(({ id }) => id), ['-9223372036854775808', '0', '03000000-0000-4000-8000-000000000001']);
      assert.deepEqual((await snapshot.readBatch('uploaded_file', uploads[2].id, 1)).rows.map(({ id }) => id),
        ['03000000-0000-4000-8000-000000000002']);
      assert.equal(assetKeyKind('private/attachments/-9223372036854775808/body.txt'), 'original');
      assert.equal(assetKeyKind('private/attachments/0/body.txt'), 'original');
      assert.throws(() => assetKeyKind('private/attachments/-9223372036854775809/body.txt'), refuses('asset-key'));

      assert.deepEqual([...cards.slice(0, 2)].reverse().sort(compareSourcePosition).map(({ id }) => id),
        ['-9223372036854775808', '-9007199254740993']);
      assert.deepEqual(cards.filter((row) => row.list_changed_at).sort(compareSourceHistory).map(({ id }) => id),
        ['9007199254740997', '9007199254740996']);
      const payload = (await snapshot.readBatch('action', '711', 1)).rows[0].data.value;
      assert.deepEqual(payload.card, { id: '9007199254740993' });
      assert.ok(payload.sample instanceof SourceJsonNumber);
      assert.equal(payload.sample.decimal, '0.000000000000000001');
      assert.equal(payload.flag, false);
      assert.equal(payload.absentContrast, null);
      assert.equal(Object.hasOwn(payload, 'missing'), false);
      assert.equal(payload.empty, '');
      return cards.length;
    });
    assert.equal(exact.value, 12);
    postgres.write(database, `UPDATE public.card SET description=repeat('a',2097152) WHERE id=-9223372036854775808`);
    await assert.rejects(inspectMigration(request, owner, config), refuses('source-read'));
    postgres.write(database, `DELETE FROM public.card WHERE id IN (-9223372036854775808,-9007199254740993,0,2,10,9223372036854775807)`);

    const current = await inspectMigration(request, owner, config);
    await testBatchRecovery({ request, config, receipt: current, postgres, database });

    postgres.write(database, 'GRANT UPDATE(name) ON public.board TO fixture_reader');
    await assert.rejects(inspectMigration(request, owner, config), refuses('source-role'));
    postgres.write(database, 'REVOKE UPDATE(name) ON public.board FROM fixture_reader');
    const cardFields = sourceColumns.card.map((column) => '"' + column + '"').join(',');
    postgres.write(database, 'REVOKE SELECT (' + cardFields + ') ON public.card FROM fixture_reader; GRANT SELECT(id) ON public.card TO fixture_reader');
    await assert.rejects(inspectMigration(request, owner, config), refuses('source-role'));
    postgres.write(database, 'GRANT SELECT (' + cardFields + ') ON public.card TO fixture_reader');
    postgres.write(database, 'ALTER TABLE public.board ADD COLUMN drift text');
    await assert.rejects(inspectMigration(request, owner, config), refuses('source-catalog'));
    postgres.write(database, 'ALTER TABLE public.board DROP COLUMN drift');
    postgres.write(database, "UPDATE public.migration SET name = 'some_other_edition.js' WHERE id = 1");
    await assert.rejects(inspectMigration(request, owner, config), refuses('source-ledger'));
    postgres.write(database, "UPDATE public.migration SET name = '20180721220455_create_user_account_table.js' WHERE id = 1");
    const rebuilt = join(root, 'planka-fixture');
    await mkdir(rebuilt, { mode: 0o700 });
    await writeFile(join(rebuilt, 'asset-manifest.json'), bundle.assetManifest, { mode: 0o600 });
    await writeFile(join(rebuilt, 'source.sql'), bundle.dump, { mode: 0o600 });
    const differentEdition = JSON.parse(bundle.manifest);
    differentEdition.source.edition = 'business';
    await writeFile(join(rebuilt, 'manifest.json'), JSON.stringify(differentEdition), { mode: 0o600 });
    await assert.rejects(inspectMigration({ ...request, manifest: join(rebuilt, 'manifest.json') }, owner, config), refuses('source-edition'));

    const asset = JSON.parse(bundle.assetManifest).files.find(({ key }) => key.endsWith('Fixture Deck.txt'));
    const derivative = JSON.parse(bundle.assetManifest).files.find(({ key }) => key.includes('outside-720'));
    // Restore the exact ledger using the independently authored source fixture before asset diagnostics.
    const expectedLedger = (await readFile(new URL('../fixtures/planka/migrations.txt', import.meta.url), 'utf8')).split('\n')[0];
    postgres.write(database, "UPDATE public.migration SET name = '" + expectedLedger + "' WHERE id = 1");
    await writeFile(join(prepared.assets, asset.key), Buffer.alloc(asset.size, 88));
    await assert.rejects(withMigrationSnapshot(request, owner, config, undefined, { expectedFingerprint: before }, noAdmission),
      refuses('asset-integrity'));
    await rm(join(prepared.assets, asset.key));
    await rm(join(prepared.assets, derivative.key));
    const missing = await inspectMigration(request, owner, config);
    assert.deepEqual(missing.assets, { present: 7, missingOriginals: 1, missingDerivatives: 1 });
  }
});

async function testBatchRecovery({ request, config, receipt, postgres, database }) {
  await withFixtureMongo(async ({ db, directory }) => {
    const installationId = randomUUID();
    const writerPath = join(directory, 'writer');
    await mkdir(writerPath, { mode: 0o750 });
    await chmod(writerPath, 0o750);
    const install = db.collection('installation');
    await install.insertOne({ _id: 'installation', installationId, schemaVersion: 0, activeGenerationId: null,
      setup: { mode: 'import', pendingAction: 'migration-preflight', enrollmentGenerationId: null } });
    await migrateStorageSchema(db, installationId);
    const preflightPath = join(directory, 'migration');
    await mkdir(preflightPath, { mode: 0o700 });
    const records = db.collection('importRuns');
    const capture = { mongoBytes: '1', blobBytes: '2', stagingBytes: '3' };
    let interrupted;
    let intentBytes;
    async function publish(hook) {
      const ownedDirectory = await anchoredDirectory(preflightPath, owner, 0o700);
      const publication = acquireWriterDirectory(writerPath, owner, owner);
      try {
        return await persistMigrationPreflight(publication, db, installationId, ownedDirectory, owner,
          request, receipt, capture, hook);
      } finally { publication.release(); await ownedDirectory.close(); }
    }
    await assert.rejects(publish(async () => {
      interrupted = await records.findOne({ installationId });
      const names = await readdir(preflightPath);
      assert.equal(names.length, 1);
      assert.match(names[0], /^\.intent-/u);
      intentBytes = await readFile(join(preflightPath, names[0]));
      assert.equal(interrupted.id, JSON.parse(intentBytes).runId);
      throw new Error('Interrupted after acknowledged Mongo write.');
    }), refuses('target-write'));
    assert.equal(await records.countDocuments(), 1);
    assert.ok(interrupted && intentBytes);
    await records.updateOne({ _id: interrupted._id }, { $set: { 'fingerprint.sha256': '0'.repeat(64) } }, durable);
    await assert.rejects(publish(), refuses('target-write'));
    assert.equal((await readdir(preflightPath)).length, 1);
    await records.updateOne({ _id: interrupted._id }, { $set: { fingerprint: interrupted.fingerprint } }, durable);
    const completed = await publish();
    assert.equal(completed.runId, interrupted.id);
    assert.deepEqual(await readFile(join(preflightPath, completed.runId + '.json')), intentBytes);
    assert.deepEqual(await publish(), completed);
    assert.equal(await records.countDocuments(), 1);
    assert.equal(Object.hasOwn(completed, 'checkpointKey'), false);
    assert.equal(Object.hasOwn(interrupted, 'checkpointKey'), false);

    const { id: runId, generationId } = interrupted;
    const identity = { installationId, generationId, runId, fingerprint: receipt.fingerprint };
    const key = importRunKey(identity);
    const staged = db.collection('cards');
    const cursorScope = { generationId, runId, fingerprint: receipt.fingerprint.sha256, pass: 'reserve', table: 'card' };
    const cursors = migrationCursors(randomBytes(32));
    const atStart = cursors.seal(cursorScope, null);
    assert.equal(cursors.open(cursorScope, atStart), null);
    assert.equal(cursors.open(cursorScope, cursors.seal(cursorScope, '-9223372036854775808')), '-9223372036854775808');
    assert.equal(cursors.open(cursorScope, cursors.seal(cursorScope, '0')), '0');
    for (const change of [{ runId: randomUUID() }, { generationId: randomUUID() }, { fingerprint: '0'.repeat(64) },
      { pass: 'edges' }, { table: 'board' }]) {
      assert.throws(() => cursors.open({ ...cursorScope, ...change }, atStart), refuses('target-write'));
    }
    const tampered = atStart[0] === 'A' ? 'B' + atStart.slice(1) : 'A' + atStart.slice(1);
    assert.throws(() => cursors.open(cursorScope, tampered), refuses('target-write'));

    const lease = acquireWriterDirectory(writerPath, owner, owner);
    let expiredProof;
    const run = (callback) => withMigrationSnapshot(request, owner, config, undefined,
      { batchSize: 1, expectedFingerprint: receipt.fingerprint.sha256 }, callback);
    let admitted = 0;
    async function batch(proof, checkpoint, interrupt) {
      expiredProof = proof;
      admitted += 1;
      const source = await proof.readBatch('card', checkpoint?.lastSourceId ?? null, 2);
      return writeMigrationBatch(lease, db, identity, proof, cursors, checkpoint,
        { pass: 'reserve', table: 'card', lastSourceId: source.lastSourceId }, async () => {
          await assert.rejects(writeMigrationBatch(lease, db, identity, proof, cursors, checkpoint,
            { pass: 'reserve', table: 'card', lastSourceId: source.lastSourceId },
            async () => assert.fail('Overlapping batch reached its effects')), refuses('target-write'));
          for (const row of source.rows) {
            const id = legacyPublicId(receipt.capture.source.instanceId, 'card', row.id);
            await staged.updateOne({ _id: workspaceKey(generationId, id), generationId, id },
              { $setOnInsert: { name: row.name } }, { ...durable, upsert: true });
            if (interrupt) throw new MigrationError('target-write', 'Interrupted after durable effect.');
          }
        });
    }

    try {
      await assert.rejects(run((proof) => batch(proof, null, true)), refuses('target-write'));
      assert.equal((await records.findOne(key)).checkpoint, null);
      assert.equal(await staged.countDocuments({ generationId }), 1);

      const initialRows = await staged.find({ generationId }).toArray();
      postgres.write(database, "UPDATE public.card SET name='changed consumed row' WHERE id=9007199254740993");
      await assert.rejects(run((proof) => batch(proof, null, false)), refuses('source-changed'));
      assert.equal(admitted, 1);
      assert.equal((await records.findOne(key)).checkpoint, null);
      assert.deepEqual(await staged.find({ generationId }).toArray(), initialRows);
      postgres.write(database, "UPDATE public.card SET name='Rotate the test prism' WHERE id=9007199254740993");

      const { value: first } = await run((proof) => batch(proof, null, false));
      assert.equal(cursors.open(cursorScope, first.token), '9007199254740994');
      assert.deepEqual((await records.findOne(key)).checkpoint, first);
      assert.equal(await staged.countDocuments({ generationId }), 2);
      postgres.write(database, "UPDATE public.card SET created_at='2026-02-11 08:09:10.123459' WHERE id=9007199254740993");
      const frozen = await records.findOne(key);
      await assert.rejects(run((proof) => batch(proof, first, false)), refuses('source-changed'));
      assert.deepEqual(await records.findOne(key), frozen);
      assert.equal(await staged.countDocuments({ generationId }), 2);
      postgres.write(database, "UPDATE public.card SET created_at='2026-02-11 08:09:10.123456' WHERE id=9007199254740993");

      const retry = await run(async (proof) => writeMigrationBatch(lease, db, identity, proof, cursors, null, first,
        async () => assert.fail('Acknowledged batch replayed effects')));
      assert.deepEqual(retry.value, first);

      await assert.rejects(writeMigrationBatch(lease, db, identity, expiredProof, cursors, first,
        { pass: 'reserve', table: 'card', lastSourceId: '9007199254740995' }, async () => assert.fail('Expired proof admitted')),
      refuses('source-changed'));
      const { value: second } = await run((proof) => batch(proof, first, false));
      assert.equal(cursors.open(cursorScope, second.token), '9007199254740996');
      assert.equal(await staged.countDocuments({ generationId }), 4);
      assert.equal((await install.findOne({ _id: 'installation' })).activeGenerationId, null);
      assert.equal((await records.findOne(key)).state, 'staging');
    } finally { lease.release(); }
  });
}

test('materialized assets resolve exact Unix filename bytes without replacement aliases', async (t) => {
  const root = await localDirectory(t);
  const assets = join(root, 'assets');
  const folder = join(assets, 'private/attachments/1');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const leaf = '�.txt';
  const key = 'private/attachments/1/' + leaf;
  const bytes = Buffer.from('synthetic file bytes');
  await writeFile(join(folder, leaf), bytes, { mode: 0o600 });
  const manifest = new Map([[key, { key, size: bytes.length, sha256: sha256(bytes) }]]);
  const reader = await inspectDirectory(assets, owner, manifest);
  assert.deepEqual(await reader.inspect(manifest.get(key)), { length: bytes.length, digest: sha256(bytes) });
  await reader.close();

  const invalidPath = Buffer.concat([Buffer.from(folder + '/'), Buffer.from([0xff]), Buffer.from('.txt')]);
  await writeFile(invalidPath, bytes, { mode: 0o600 });
  try { await assert.rejects(inspectDirectory(assets, owner, manifest), refuses('asset-integrity')); }
  finally { await unlink(invalidPath); }
});

test('migration object versions, streamed lengths and shared-volume capacity are verified independently', async () => {
  const release = '2.3.0';
  const value = JSON.parse(await readFile(join(synthetic(release), 'manifest.json')));
  value.asset.kind = 'object';
  const capture = readCaptureManifest(Buffer.from(JSON.stringify(value)));
  const service = parseObjectService(JSON.stringify({ fixture: { base: 'https://storage.fixture.invalid/frozen/', snapshotId: capture.asset.snapshotId } }),
    'fixture', capture);
  const key = 'private/attachments/1/Case-sensitive File.txt';
  const body = Buffer.from('independent stored length');
  const metadata = { key, versionId: 'v-locked', size: body.length, sha256: sha256(body) };
  const mutable = Buffer.from(JSON.stringify({ formatVersion: 1, files: [{ ...metadata, versionId: 'null' }] }));
  assert.throws(() => readAssetManifest(mutable, { ...capture, asset: { ...capture.asset, manifestSha256: sha256(mutable) } }),
    refuses('asset-manifest'));
  const manifest = new Map([[key, metadata]]);
  const source = new Map([[key, { kind: 'original', sourceLength: null }]]);
  const good = inspectObjects(service, async (url) => {
    assert.equal(url.pathname, '/frozen/private/attachments/1/Case-sensitive%20File.txt');
    assert.equal(url.searchParams.get('versionId'), 'v-locked');
    return new Response(body, { headers: { 'x-amz-version-id': 'v-locked' } });
  });
  const checked = await reconcileAssets(good, manifest, source);
  assert.equal(checked.bytes, BigInt(body.length));
  for (const [content, version] of [[body, 'v-drifted'], [body.subarray(1), 'v-locked'], [Buffer.alloc(body.length), 'v-locked']]) {
    const bad = inspectObjects(service, async () => new Response(content, { headers: { 'x-amz-version-id': version } }));
    await assert.rejects(reconcileAssets(bad, manifest, source), refuses('asset-integrity'));
  }
  const reserve = 512n * 1024n ** 2n;
  const estimate = { sourceBytes: 120n, sourceIndexes: 80n, sourceRows: 10n, assetBytes: 33n };
  const funding = { mongo: { id: 1n, free: reserve + 10_800n }, blobs: { id: 2n, free: 66n }, staging: { id: 3n, free: reserve + 33n } };
  assert.doesNotThrow(() => assertMigrationCapacity(estimate, funding));
  assert.throws(() => assertMigrationCapacity(estimate, { ...funding, staging: { ...funding.staging, id: 1n } }), refuses('target-capacity'));
});
