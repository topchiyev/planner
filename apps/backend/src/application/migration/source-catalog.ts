import { isDeepStrictEqual } from 'node:util';
import type { Client } from 'pg';
import baseline from './planka-community-catalog.json' with { type: 'json' };
import { MigrationError, sha256 } from './manifest.js';

export const sourceTables = Object.freeze(Object.keys(baseline.tables).sort());
const migrationDigest = '32a3fa9b45c357f523a5f02189ccb63376e9bd35b9844d00296ecf6b4f0b71ef';
const finalMigration = '20260918000000_add_show_card_counter_to_boards.js';

const catalogSql = `WITH source_tables AS (
  SELECT rel.oid, rel.relname
  FROM pg_catalog.pg_class AS rel
  JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public' AND rel.relkind IN ('r', 'p', 'v', 'm', 'f')
)
SELECT jsonb_build_object(
  'tables', (
    SELECT jsonb_object_agg(relname, (
      SELECT jsonb_agg(jsonb_build_array(
        att.attname,
        pg_catalog.format_type(att.atttypid, att.atttypmod),
        NOT att.attnotnull
      ) ORDER BY att.attnum)
      FROM pg_catalog.pg_attribute AS att
      WHERE att.attrelid = source_tables.oid AND att.attnum > 0 AND NOT att.attisdropped
    ))
    FROM source_tables
  ),
  'foreignKeys', (
    SELECT count(*)
    FROM source_tables
    JOIN pg_catalog.pg_constraint AS con ON con.conrelid = source_tables.oid
    WHERE con.contype = 'f'
  ),
  'constraints', (
    SELECT jsonb_object_agg(source_tables.relname || '.' || con.conname, jsonb_build_array(
      source_tables.relname, con.contype, pg_catalog.pg_get_constraintdef(con.oid)
    ))
    FROM source_tables
    JOIN pg_catalog.pg_constraint AS con ON con.conrelid = source_tables.oid
  ),
  'indexes', (
    SELECT jsonb_object_agg(idx.relname, jsonb_build_array(
      source_tables.relname,
      method.amname,
      ind.indisunique,
      ind.indisvalid,
      pg_catalog.pg_get_indexdef(idx.oid),
      pg_catalog.pg_get_expr(ind.indpred, ind.indrelid)
    ))
    FROM source_tables
    JOIN pg_catalog.pg_index AS ind ON ind.indrelid = source_tables.oid
    JOIN pg_catalog.pg_class AS idx ON idx.oid = ind.indexrelid
    JOIN pg_catalog.pg_am AS method ON method.oid = idx.relam
  )
)`;

export async function assertSourceCatalog(client: Client) {
  const shape = await client.query<{ valid: boolean }>(`
    SELECT
      count(*) = 34
      AND bool_and(ns.nspname = 'public' AND rel.relkind = 'r'
        AND NOT rel.relispartition AND NOT rel.relrowsecurity AND NOT rel.relforcerowsecurity
        AND rel.relpersistence = 'p') AS valid
    FROM pg_catalog.pg_class AS rel
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname <> 'information_schema' AND ns.nspname !~ '^pg_'
      AND rel.relkind IN ('r', 'p', 'v', 'm', 'f')
  `);
  if (shape.rows[0]?.valid !== true)
    throw new MigrationError('source-catalog', 'The restored source has unsupported relations or schema ambiguity.');
  const result = await client.query<{ jsonb_build_object: unknown }>(catalogSql);
  if (!isDeepStrictEqual(result.rows[0]?.jsonb_build_object, baseline))
    throw new MigrationError('source-catalog', 'The restored source does not match the supported Community catalog.');
  const ledger = await client.query<{ name: string }>(
    'SELECT name FROM public.migration ORDER BY name COLLATE "C"');
  const lock = await client.query<{ is_locked: number }>('SELECT is_locked FROM public.migration_lock');
  const names = ledger.rows.map((row) => row.name);
  if (names.length !== 23 || names.at(-1) !== finalMigration || new Set(names).size !== names.length
      || sha256(Buffer.from(names.join('\n') + '\n')) !== migrationDigest
      || lock.rows.length !== 1 || lock.rows[0].is_locked !== 0) {
    throw new MigrationError('source-ledger', 'The restored source migration ledger is incomplete or unsupported.');
  }
}
