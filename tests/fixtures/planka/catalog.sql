BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;

WITH source_tables AS (
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
);
COMMIT;
