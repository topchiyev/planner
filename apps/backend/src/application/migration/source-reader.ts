import pg from 'pg';
import type { Client } from 'pg';
import { assetKeyKind, MigrationError, registerPath } from './manifest.js';
import { assertSourceCatalog, sourceColumns, sourceTables } from './source-catalog.js';
import { assertSourceSocket, parseSourceService } from './source-service.js';

const integer = /^(?:0|[1-9][0-9]{0,30})$/u;
export type SourceAsset = { kind: 'original' | 'derivative'; sourceLength: bigint | null };

const roleSql = `
  SELECT roles.rolcanlogin
    AND NOT (roles.rolsuper OR roles.rolinherit OR roles.rolcreaterole OR roles.rolcreatedb OR roles.rolreplication OR roles.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership WHERE membership.member = roles.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database AS database WHERE database.datdba = roles.oid)
    AND NOT pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE, TEMPORARY')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace AS ns
      WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'
        AND (ns.nspowner = roles.oid OR pg_catalog.has_schema_privilege(ns.oid, 'CREATE'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS rel JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'
        AND (rel.relowner = roles.oid OR CASE
          WHEN rel.relkind IN ('r', 'v', 'f', 'm', 'p') THEN
            pg_catalog.has_table_privilege(rel.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
            OR pg_catalog.has_any_column_privilege(rel.oid, 'INSERT, UPDATE, REFERENCES')
          WHEN rel.relkind = 'S' THEN
            pg_catalog.has_sequence_privilege(rel.oid, 'USAGE, UPDATE')
          ELSE false END)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS proc JOIN pg_catalog.pg_namespace AS ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'
        AND (proc.proowner = roles.oid OR proc.prosecdef AND pg_catalog.has_function_privilege(proc.oid, 'EXECUTE'))
    ) AS allowed
  FROM pg_catalog.pg_roles AS roles WHERE roles.rolname = session_user AND current_user = session_user
`;

const assetsSql = `
  WITH keys AS (
    SELECT 'private/attachments/' || (data->>'uploadedFileId') || '/' || (data->>'filename') AS key,
           'original' AS kind, data->>'size' AS source_length
    FROM public.attachment WHERE type = 'file'
    UNION
    SELECT 'private/attachments/' || (data->>'uploadedFileId') || '/thumbnails/outside-' ||
           variant || '.' || (data->'image'->>'thumbnailsExtension'), 'derivative', NULL
    FROM public.attachment CROSS JOIN (VALUES ('360'), ('720')) AS variants(variant)
    WHERE type = 'file' AND data->'image'->>'thumbnailsExtension' IS NOT NULL
    UNION
    SELECT 'protected/user-avatars/' || (avatar->>'uploadedFileId') || '/' ||
           variant || '.' || (avatar->>'extension'), kind, NULL
    FROM public.user_account CROSS JOIN (VALUES ('original', 'original'), ('cover-180', 'derivative')) AS variants(variant, kind)
    WHERE avatar IS NOT NULL
    UNION
    SELECT 'protected/background-images/' || uploaded_file_id || '/' || variant || '.' ||
           extension, kind, NULL
    FROM public.background_image CROSS JOIN (VALUES ('original', 'original'), ('outside-360', 'derivative')) AS variants(variant, kind)
  )
  SELECT key, kind, source_length FROM keys ORDER BY key COLLATE "C" LIMIT 100001
`;

async function sourceAssets(client: Client) {
  const snapshot = await client.query<{ key: string | null; kind: SourceAsset['kind']; source_length: string | null }>(assetsSql);
  if (snapshot.rows.length > 100_000) throw new MigrationError('source-read', 'The source exceeds the asset preflight limit.');
  const paths = new Map<string, string>();
  const entries = new Map<string, SourceAsset>();
  for (const { key, kind, source_length } of snapshot.rows) {
    if (!key || assetKeyKind(key) !== kind || entries.has(key)
      || (key.startsWith('private/attachments/') && kind === 'original' && !integer.test(source_length ?? ''))) {
      throw new MigrationError('asset-key', 'The source refers to an invalid or ambiguous asset key.');
    }
    registerPath(paths, key);
    entries.set(key, { kind, sourceLength: source_length === null ? null : BigInt(source_length) });
  }
  return entries;
}

async function sourceInventory(client: Client) {
  const rows: Record<string, string> = {};
  let dataBytes = 0n;
  let indexBytes = 0n;
  for (const table of sourceTables) {
    const result = await client.query<{ rows: string; data: string; indexes: string }>(
      'SELECT count(*)::text AS rows, pg_catalog.pg_table_size($1::regclass)::text AS data, ' +
      'pg_catalog.pg_indexes_size($1::regclass)::text AS indexes FROM public."' + table + '"', ['public.' + table]);
    const entry = result.rows[0];
    if (!entry || ![entry.rows, entry.data, entry.indexes].every((item) => integer.test(item))) {
      throw new MigrationError('source-read', 'The source inventory could not be verified.');
    }
    rows[table] = entry.rows;
    dataBytes += BigInt(entry.data);
    indexBytes += BigInt(entry.indexes);
  }
  return { rows, dataBytes, indexBytes };
}

export async function withSourceSnapshot<T>(service: ReturnType<typeof parseSourceService>, read: (client: Client) => Promise<T>) {
  await assertSourceSocket(service);
  const client = new pg.Client(service);
  let began = false;
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    await client.query("SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '4s'; " +
      "SET LOCAL idle_in_transaction_session_timeout = '45s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL search_path = pg_catalog, public");
    const result = await client.query<{
      server_version: string; server_version_num: string; transaction_read_only: string; transaction_isolation: string;
      zone: string; database: string; username: string; inet_server_addr: string | null;
    }>(`
      SELECT current_setting('server_version') AS server_version,
        current_setting('server_version_num') AS server_version_num,
        current_setting('transaction_read_only') AS transaction_read_only,
        current_setting('transaction_isolation') AS transaction_isolation,
        current_setting('TimeZone') AS zone, current_database() AS database, session_user AS username, inet_server_addr()::text
    `);
    const scope = result.rows[0];
    if (!scope || scope.database !== service.database || scope.username !== service.user || scope.inet_server_addr !== null
      || scope.transaction_read_only !== 'on' || scope.transaction_isolation !== 'repeatable read' || scope.zone !== 'UTC'
      || !/^17[0-9]{4}$/u.test(scope.server_version_num)) {
      throw new MigrationError('source-service', 'Use a private PostgreSQL 17 restore with a verified read-only snapshot.');
    }
    if ((await client.query<{ allowed: boolean }>(roleSql)).rows[0]?.allowed !== true)
      throw new MigrationError('source-role', 'Use a dedicated login with only SELECT access and no ownership or role membership.');
    await assertSourceCatalog(client);
    const grants = await client.query<{ complete: boolean }>(`
      SELECT NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_each($1::jsonb) AS required(table_name, columns)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(required.columns) AS requested(column_name)
        JOIN pg_catalog.pg_namespace AS ns ON ns.nspname = 'public'
        JOIN pg_catalog.pg_class AS rel ON rel.relnamespace = ns.oid AND rel.relname = required.table_name
        JOIN pg_catalog.pg_attribute AS att ON att.attrelid = rel.oid AND att.attname = requested.column_name
        WHERE NOT pg_catalog.has_column_privilege(rel.oid, att.attnum, 'SELECT')
      ) AS complete
    `, [JSON.stringify(sourceColumns)]);
    if (grants.rows[0]?.complete !== true)
      throw new MigrationError('source-role', 'The source login lacks SELECT on part of the supported catalog.');
    const value = await read(client);
    await client.query('COMMIT');
    began = false;
    return { value, restoredPostgresVersion: scope.server_version.match(/^[0-9]+\.[0-9]+/u)?.[0] ?? '17' };
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof MigrationError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === '42501')
      throw new MigrationError('source-role', 'The source login lacks SELECT on part of the supported catalog.');
    throw new MigrationError('source-read', 'The isolated PostgreSQL source could not be read.');
  } finally { await client.end().catch(() => undefined); }
}

export async function readSourcePreflight(service: ReturnType<typeof parseSourceService>) {
  const { value, restoredPostgresVersion } = await withSourceSnapshot(service, async (client) => ({
    ...await sourceInventory(client),
    assets: await sourceAssets(client),
  }));
  return { ...value, restoredPostgresVersion };
}
