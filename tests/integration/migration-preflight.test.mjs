import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inspectObjects, parseObjectService, reconcileAssets } from '../../apps/backend/dist/application/migration/assets.js';
import { readCaptureManifest, sha256 } from '../../apps/backend/dist/application/migration/manifest.js';
import { inspectMigration } from '../../apps/backend/dist/application/migration/preflight.js';
import { sourceColumns } from '../../apps/backend/dist/application/migration/source-catalog.js';
import { prepareMigration } from '../../apps/backend/dist/application/migration/prepare.js';
import { assertMigrationCapacity } from '../../apps/backend/dist/native/migration-state.js';
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

    if (release !== '2.3.1') continue;
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
    await assert.rejects(inspectMigration(request, owner, config), refuses('asset-integrity'));
    await rm(join(prepared.assets, asset.key));
    await rm(join(prepared.assets, derivative.key));
    const missing = await inspectMigration(request, owner, config);
    assert.deepEqual(missing.assets, { present: 7, missingOriginals: 1, missingDerivatives: 1 });
  }
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
