import assert from 'node:assert/strict';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAssets, sha256 } from '../fixtures/planka/asset-checks.mjs';
import { startFixturePostgres } from '../fixtures/planka/private-postgres.mjs';
import { assembleSnapshot } from '../fixtures/planka/snapshot.mjs';

const fixture = (...parts) => fileURLToPath(new URL(parts.join('/'), new URL('../fixtures/planka/', import.meta.url)));
const read = (path) => readFileSync(fixture(path), 'utf8');
const readJson = (path) => JSON.parse(read(path));
const baseline = readJson('catalog.json');
const catalog = read('catalog.sql');
const migrationNames = read('migrations.txt');
const { releases, migrationNamesSha256 } = readJson('source-pins.json');
const expectedRows = {
  action: 2,
  attachment: 6,
  background_image: 1,
  base_custom_field_group: 1,
  board: 2,
  board_membership: 5,
  board_subscription: 1,
  card: 6,
  card_label: 1,
  card_membership: 1,
  card_subscription: 1,
  comment: 1,
  config: 1,
  custom_field: 1,
  custom_field_group: 2,
  custom_field_value: 2,
  internal_config: 1,
  label: 1,
  list: 7,
  migration: 23,
  migration_lock: 1,
  notification: 2,
  notification_service: 1,
  project: 2,
  project_favorite: 1,
  project_manager: 2,
  session: 1,
  storage_usage: 1,
  task: 3,
  task_list: 1,
  trusted_device: 0,
  uploaded_file: 5,
  user_account: 5,
  webhook: 1,
};
const expectedWorkspace = { '2.3.0': 'Juniper Aperture Lab', '2.3.1': 'Kestrel Aperture Lab' };

const assetProjection = `
  WITH keys AS (
    SELECT 'private/attachments/' || (data->>'uploadedFileId') || '/' || (data->>'filename') AS key,
           'attachment' AS kind, (data->>'size')::integer AS size
    FROM public.attachment WHERE type = 'file'
    UNION
    SELECT 'private/attachments/' || (data->>'uploadedFileId') || '/thumbnails/outside-' ||
           variant || '.' || (data->'image'->>'thumbnailsExtension'), 'derivative', NULL
    FROM public.attachment CROSS JOIN (VALUES ('360'), ('720')) AS variants(variant)
    WHERE type = 'file' AND data->'image'->>'thumbnailsExtension' IS NOT NULL
    UNION
    SELECT 'protected/user-avatars/' || (avatar->>'uploadedFileId') || '/' ||
           variant || '.' || (avatar->>'extension'), 'avatar', (avatar->>'size')::integer
    FROM public.user_account CROSS JOIN (VALUES ('original'), ('cover-180')) AS variants(variant)
    WHERE avatar IS NOT NULL
    UNION
    SELECT 'protected/background-images/' || uploaded_file_id || '/' || variant || '.' ||
           extension, 'background', size::integer
    FROM public.background_image CROSS JOIN (VALUES ('original'), ('outside-360')) AS variants(variant)
  )
  SELECT jsonb_object_agg(key, jsonb_build_object('kind', kind, 'size', size)) FROM keys;
`;

function assertRepresentativeRows(query, workspace) {
  function rows(select) {
    return JSON.parse(query(`SELECT jsonb_agg(to_jsonb(row)) FROM (${select}) AS row;`));
  }

  assert.equal(query('SELECT name FROM public.project WHERE id = 201;'), workspace);
  assert.deepEqual(rows(`
    SELECT id::text, position, type, is_closed, is_due_completed,
           to_char(created_at AT TIME ZONE current_setting('TimeZone'),
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_utc
    FROM public.card WHERE list_id = 401 AND id > 9007199254740992
    ORDER BY position, id LIMIT 2
  `), [
    {
      id: '9007199254740993', position: 1024, type: 'project', is_closed: false,
      is_due_completed: false, created_utc: '2026-02-11T08:09:10.123456Z',
    },
    {
      id: '9007199254740994', position: 1024, type: 'story', is_closed: false,
      is_due_completed: null, created_utc: '2026-02-11T08:09:10.123457Z',
    },
  ]);
  assert.deepEqual(rows(`
    SELECT card.id::text, current.type, card.position, card.is_closed,
           card.prev_list_id::text, prior.id IS NULL AS prior_missing
    FROM public.card
    JOIN public.list AS current ON card.list_id = current.id
    LEFT JOIN public.list AS prior ON card.prev_list_id = prior.id
    WHERE current.type IN ('closed', 'archive', 'trash') ORDER BY card.id
  `), [
    { id: '9007199254740995', type: 'closed', position: 2048, is_closed: true, prev_list_id: '401', prior_missing: false },
    { id: '9007199254740996', type: 'archive', position: null, is_closed: true, prev_list_id: '499', prior_missing: true },
    { id: '9007199254740997', type: 'trash', position: null, is_closed: false, prev_list_id: '401', prior_missing: false },
  ]);
  assert.deepEqual(rows(`
    SELECT account.role, account.username, account.is_deactivated, account.is_totp_enabled,
           member.role AS board_role, member.can_comment
    FROM public.user_account AS account
    LEFT JOIN public.board_membership AS member ON account.id = member.user_id AND member.board_id = 301
    ORDER BY account.id
  `), [
    { role: 'admin', username: 'iris-fixture', is_deactivated: false, is_totp_enabled: true, board_role: 'editor', can_comment: null },
    { role: 'projectOwner', username: null, is_deactivated: false, is_totp_enabled: false, board_role: 'editor', can_comment: null },
    { role: 'boardUser', username: 'sage-fixture', is_deactivated: false, is_totp_enabled: false, board_role: 'viewer', can_comment: true },
    { role: 'boardUser', username: null, is_deactivated: false, is_totp_enabled: false, board_role: 'viewer', can_comment: false },
    { role: 'boardUser', username: 'yarrow-fixture', is_deactivated: true, is_totp_enabled: false, board_role: null, can_comment: null },
  ]);
  assert.deepEqual(rows(`
    SELECT task.linked_card_id::text AS target, task.is_completed,
           origin.board_id = destination.board_id AS same_board, viewer.id IS NOT NULL AS viewer_member
    FROM public.task
    JOIN public.task_list ON task.task_list_id = task_list.id
    JOIN public.card AS origin ON task_list.card_id = origin.id
    JOIN public.card AS destination ON task.linked_card_id = destination.id
    LEFT JOIN public.board_membership AS viewer ON viewer.board_id = destination.board_id AND viewer.user_id = 103
    ORDER BY task.id
  `), [
    { target: '9007199254740995', is_completed: true, same_board: true, viewer_member: true },
    { target: '9007199254740998', is_completed: false, same_board: false, viewer_member: false },
  ]);
  assert.deepEqual(rows(`
    SELECT value.card_id::text, value.custom_field_group_id::text, value.custom_field_id::text,
           value.content, instance.board_id::text, instance.card_id::text AS instance_card_id
    FROM public.custom_field_value AS value
    JOIN public.custom_field_group AS instance ON value.custom_field_group_id = instance.id
    JOIN public.custom_field AS field ON value.custom_field_id = field.id
         AND field.base_custom_field_group_id = instance.base_custom_field_group_id
    ORDER BY value.id
  `), [
    { card_id: '9007199254740993', custom_field_group_id: '571', custom_field_id: '581', content: '  blue / λ  ', board_id: '301', instance_card_id: null },
    { card_id: '9007199254740993', custom_field_group_id: '572', custom_field_id: '581', content: '0', board_id: null, instance_card_id: '9007199254740993' },
  ]);
  assert.deepEqual(rows(`
    SELECT data->'fromList' AS former_list, board_id::text
    FROM public.action WHERE type = 'moveCard'
  `), [{ former_list: { id: '499', type: 'closed', name: 'Earlier batch' }, board_id: null }]);
  assert.deepEqual(rows(`
    SELECT notification.id::text, notification.is_read, card.id IS NOT NULL AS card_exists,
           action.id IS NOT NULL AS action_exists
    FROM public.notification
    LEFT JOIN public.card ON card.id = notification.card_id
    LEFT JOIN public.action ON action.id = notification.action_id
    ORDER BY notification.id
  `), [
    { id: '721', is_read: false, card_exists: false, action_exists: false },
    { id: '722', is_read: true, card_exists: true, action_exists: false },
  ]);
  assert.deepEqual(rows(`
    SELECT attachment.data->>'url' AS url FROM public.attachment
    WHERE type = 'link' ORDER BY id
  `), [
    { url: 'https://handbook.fixture.invalid/optics' },
    { url: 'http://127.0.0.1/fixture-only' },
  ]);
  assert.deepEqual(rows(`
    SELECT file.id, file.references_total, count(attachment.id)::integer AS attachment_count
    FROM public.uploaded_file AS file
    JOIN public.attachment ON attachment.data->>'uploadedFileId' = file.id
    GROUP BY file.id ORDER BY file.id
  `), [
    { id: '9007199254741220', references_total: 2, attachment_count: 2 },
    { id: '9007199254741221', references_total: 1, attachment_count: 1 },
    { id: '9007199254741222', references_total: 1, attachment_count: 1 },
  ]);
}

test('PLANKA Community source fixtures', async (context) => {
  assert.deepEqual(Object.keys(releases), ['2.3.0', '2.3.1']);
  assert.throws(() => assembleSnapshot('2.3.2'), /Unsupported PLANKA fixture release/);
  assert.equal(sha256(migrationNames), migrationNamesSha256);
  const names = migrationNames.trimEnd().split('\n');
  assert.equal(new Set(names).size, 23);
  assert.deepEqual(names, [...names].sort());
  assert.equal(names.at(-1), '20260918000000_add_show_card_counter_to_boards.js');
  assert.equal(Object.keys(baseline.tables).length, 34);
  assert.deepEqual(Object.keys(baseline.tables).sort(), Object.keys(expectedRows).sort());
  assert.equal(baseline.foreignKeys, 0);

  const pg = await startFixturePostgres(context);
  const sourceResults = new Map();
  for (const release of Object.keys(releases)) {
    await context.test(`loads and verifies the complete ${release} snapshot`, () => {
      const database = `planka_${release.replaceAll('.', '')}`;
      const dump = assembleSnapshot(release);
      const manifest = readJson(`${release}/manifest.json`);
      const assetManifestBytes = read(`${release}/asset-manifest.json`);
      const assetManifest = JSON.parse(assetManifestBytes);
      const assetRoot = fixture(release, 'assets');
      assert.equal(manifest.formatVersion, 1);
      assert.equal(manifest.source.release, release);
      assert.equal(manifest.source.edition, 'community');
      assert.match(manifest.source.postgresVersion, /^17\./);
      assert.match(manifest.source.instanceId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      assert.equal(new Date(manifest.capturedAt).toISOString(), manifest.capturedAt);
      assert.equal(manifest.source.dumpSha256, sha256(dump));
      assert.equal(manifest.asset.kind, 'directory');
      assert.match(manifest.asset.snapshotId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      assert.equal(manifest.asset.manifestSha256, sha256(assetManifestBytes));

      pg.write('postgres', `CREATE DATABASE ${database};`);
      pg.write(database, dump);
      pg.write(database, 'GRANT USAGE ON SCHEMA public TO fixture_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO fixture_reader;');
      const readOnly = (sql) => pg.query(database, `
        BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET LOCAL TIME ZONE 'UTC';
        ${sql}
        COMMIT;
      `);
      assert.equal(readOnly('SHOW transaction_isolation; SHOW transaction_read_only; SHOW TimeZone;'),
        'repeatable read\non\nUTC');
      assert.equal(readOnly("SELECT current_setting('listen_addresses') = '';"), 't');
      assert.throws(() => pg.query(database, 'DELETE FROM public.card;'), /42501/);
      assert.deepEqual(JSON.parse(pg.query(database, catalog)), baseline);
      assert.deepEqual(readOnly('SELECT name FROM public.migration ORDER BY id;').split('\n'), names);
      assert.equal(readOnly('SELECT is_locked FROM public.migration_lock;'), '0');

      const projections = Object.entries(baseline.tables).map(([table, columns]) => {
        const fieldList = columns.map(([name]) => `"${name}"`).join(', ');
        return `SELECT '${table}' AS name, count(to_jsonb(row)) AS total FROM (SELECT ${fieldList} FROM public."${table}") AS row`;
      });
      const rowCounts = `SELECT jsonb_object_agg(name, total) FROM (${projections.join(' UNION ALL ')}) AS counts;`;
      assert.deepEqual(JSON.parse(readOnly(rowCounts)), expectedRows);
      assertRepresentativeRows(readOnly, expectedWorkspace[release]);
      assert.equal(readOnly(`
        SELECT NOT (
          EXISTS (SELECT FROM public.user_account WHERE password IS NOT NULL OR api_key_hash IS NOT NULL
            OR api_key_prefix IS NOT NULL OR totp_secret IS NOT NULL OR totp_recovery_codes IS NOT NULL)
          OR EXISTS (SELECT FROM public.session WHERE access_token IS NOT NULL OR http_only_token IS NOT NULL
            OR pending_token IS NOT NULL)
          OR EXISTS (SELECT FROM public.config WHERE smtp_user IS NOT NULL OR smtp_password IS NOT NULL)
          OR EXISTS (SELECT FROM public.webhook WHERE access_token IS NOT NULL)
          OR EXISTS (SELECT FROM public.trusted_device)
        );
      `), 't', 'Fixture credential fields are empty');

      const sourceKeys = JSON.parse(readOnly(assetProjection));
      assert.equal(assetManifest.files.length, 9);
      checkAssets(assetRoot, assetManifest, sourceKeys);
      const notes = assetManifest.files.filter(({ key }) => key.endsWith('Deck.txt'));
      assert.equal(notes.length, 2);
      assert.equal(notes[0].sha256, notes[1].sha256);
      sourceResults.set(release, { database, manifest, assetManifest, assetRoot, sourceKeys });
    });
  }

  if (sourceResults.size !== Object.keys(releases).length) return;
  const [first, second] = [...sourceResults.values()].map(({ manifest }) => manifest);
  assert.notEqual(first.source.instanceId, second.source.instanceId);
  assert.notEqual(first.source.dumpSha256, second.source.dumpSha256);
  assert.notEqual(first.asset.snapshotId, second.asset.snapshotId);
  assert.notEqual(first.asset.manifestSha256, second.asset.manifestSha256);

  const { database, assetManifest, assetRoot, sourceKeys } = sourceResults.get('2.3.1');
  await context.test('detects database structure and ledger drift', () => {
    const readCatalog = () => JSON.parse(pg.query(database, catalog));

    pg.write(database, 'ALTER TABLE public.card DROP COLUMN is_closed;');
    assert.throws(() => assert.deepEqual(readCatalog().tables.card, baseline.tables.card), /is_closed/);
    pg.write(database, 'ALTER TABLE public.board ADD COLUMN unexpected text;');
    assert.throws(() => assert.deepEqual(readCatalog().tables.board, baseline.tables.board), /unexpected/);

    assert.throws(() => pg.write(database, "UPDATE public.user_account SET username = 'iris-fixture' WHERE id = 104;"),
      /23P01/);
    pg.write(database, `
      ALTER TABLE public.user_account DROP CONSTRAINT user_account_username_unique;
      ALTER TABLE public.user_account ADD CONSTRAINT user_account_username_unique EXCLUDE (username WITH =);
    `);
    const username = 'user_account.user_account_username_unique';
    assert.notDeepEqual(readCatalog().constraints[username], baseline.constraints[username]);
    assert.match(baseline.constraints[username][2], /username IS NOT NULL/);

    pg.write(database, `
      ALTER INDEX public.card_name_gin_index RENAME TO card_name_index;
      ALTER INDEX public.card_description_gin_index RENAME TO card_description_index;
    `);
    const changedIndexes = readCatalog().indexes;
    assert.equal(changedIndexes.card_name_gin_index, undefined);
    assert.equal(changedIndexes.card_description_gin_index, undefined);
    assert.match(baseline.indexes.card_name_gin_index[4], /USING gin \(name gin_trgm_ops\)/);
    assert.match(baseline.indexes.card_description_gin_index[4], /USING gin \(description gin_trgm_ops\)/);

    const triple = 'custom_field_value_card_id_custom_field_group_id_custom_field_i';
    assert.match(baseline.constraints[`custom_field_value.${triple}`][2],
      /UNIQUE \(card_id, custom_field_group_id, custom_field_id\)/);
    assert.throws(() => pg.write(database, `
      INSERT INTO public.custom_field_value (id, card_id, custom_field_group_id, custom_field_id, content)
      VALUES (593, 9007199254740993, 571, 581, 'duplicate');
    `), /23505/);
    pg.write(database, `ALTER TABLE public.custom_field_value DROP CONSTRAINT ${triple};`);
    assert.equal(readCatalog().constraints[`custom_field_value.${triple}`], undefined);

    pg.write(database, "UPDATE public.migration SET name = '20990101000000_unexpected.js' WHERE id = 23;");
    assert.throws(() => assert.deepEqual(pg.query(database, 'SELECT name FROM public.migration ORDER BY id;').split('\n'), names),
      /20990101000000_unexpected/);
  });

  await context.test('distinguishes absent, corrupt, ambiguous and unsafe asset paths', (testContext) => {
    const copy = mkdtempSync('/tmp/planner-planka-assets-');
    testContext.after(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(assetRoot, copy, { recursive: true });
    const targetKey = 'private/attachments/9007199254741220/Re\u0301seau Tile.png';
    const target = join(copy, targetKey);
    const original = readFileSync(target);
    const verify = () => checkAssets(copy, assetManifest, sourceKeys);

    unlinkSync(target);
    assert.throws(verify, /Absent fixture asset/);
    const corrupt = Buffer.from(original);
    corrupt[0] ^= 0xff;
    writeFileSync(target, corrupt);
    assert.throws(verify, /Corrupt fixture asset/);
    writeFileSync(target, original);

    for (const alias of [targetKey.toLowerCase(), targetKey.normalize('NFC')]) {
      const collision = join(copy, alias);
      writeFileSync(collision, original);
      assert.throws(verify, /Ambiguous fixture path/);
      unlinkSync(collision);
    }

    unlinkSync(target);
    symlinkSync(join(assetRoot, targetKey), target);
    assert.throws(verify, /Non-regular fixture asset/);
    unlinkSync(target);
    writeFileSync(target, original);

    const unsafe = structuredClone(assetManifest);
    unsafe.files[0].key = 'private/attachments/9007199254741220/../unexpected.png';
    assert.throws(() => checkAssets(copy, unsafe, sourceKeys), /Unsafe fixture path/);
    verify();
  });
});
