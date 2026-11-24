import { createHash, type Hash } from 'node:crypto';
import type { MigrationCapture } from '@planner/contracts';
import type { Client } from 'pg';
import type { VerifiedSourceAsset } from './assets.js';
import { MigrationError } from './manifest.js';
import { sourceCatalogMetadata } from './source-catalog.js';
import {
  excludedSourceTables, maximumSourceBatch, projectedSourceTables, readSourceBatch,
  SourceJsonNumber, sourceProjection, sourceProjectionVersion, type SourceBatch, type SourceTable,
} from './source-projections.js';

const version = 1;

function frame(hash: Hash, tag: string, value: string | Buffer = '') {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const header = Buffer.alloc(5);
  header.writeUInt8(tag.charCodeAt(0));
  header.writeUInt32BE(bytes.length, 1);
  hash.update(header).update(bytes);
}

function canonical(hash: Hash, value: unknown, depth = 0): void {
  if (depth > 64) throw new MigrationError('source-read', 'The source contains an unsupported nested value.');
  if (value === null) return frame(hash, 'n');
  if (typeof value === 'string') return frame(hash, 's', value);
  if (typeof value === 'boolean') return frame(hash, value ? 't' : 'f');
  if (typeof value === 'number' && Number.isFinite(value)) {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return frame(hash, 'd', bytes);
  }
  if (value instanceof SourceJsonNumber) return frame(hash, 'j', value.decimal);
  if (Array.isArray(value)) {
    frame(hash, 'a', String(value.length));
    for (const entry of value) canonical(hash, entry, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([first], [second]) => Buffer.compare(Buffer.from(first), Buffer.from(second)));
    frame(hash, 'o', String(entries.length));
    for (const [key, entry] of entries) {
      frame(hash, 'k', key);
      canonical(hash, entry, depth + 1);
    }
    return;
  }
  throw new MigrationError('source-read', 'The source contains an unsupported typed value.');
}

function stream(component: string) {
  const hash = createHash('sha256');
  canonical(hash, ['planner-migration-fingerprint', version, component]);
  return hash;
}

async function exclusions(client: Client, counts: Readonly<Record<string, string>>) {
  const { rows } = await client.query<{ type: string; count: string }>(`
    SELECT 'notificationService.' || CASE format WHEN 'text' THEN 'text' WHEN 'markdown' THEN 'markdown'
      ELSE 'other' END AS type, count(*)::text AS count FROM public.notification_service GROUP BY 1
    UNION ALL
    SELECT 'webhook.' || CASE WHEN board_id IS NOT NULL THEN 'board' WHEN project_id IS NOT NULL THEN 'project'
      WHEN user_id IS NOT NULL THEN 'user' ELSE 'installation' END, count(*)::text FROM public.webhook GROUP BY 1
    UNION ALL
    SELECT 'smtp.configured', count(*)::text FROM public.config WHERE smtp_host IS NOT NULL AND smtp_host <> ''
  `);
  return {
    tables: Object.fromEntries(excludedSourceTables.map((table) => [table, counts[table]])),
    types: Object.fromEntries(rows.map(({ type, count }) => [type, count])),
  };
}

export async function fingerprintRows(client: Client, counts: Readonly<Record<string, string>>, limit = maximumSourceBatch) {
  const hash = stream('rows');
  for (const table of projectedSourceTables) {
    canonical(hash, { table, projection: sourceProjection(table) });
    let cursor: string | null = null;
    let scanned = 0n;
    for (;;) {
      const batch: SourceBatch<SourceTable> = await readSourceBatch(client, table, cursor, limit);
      for (const row of batch.rows) canonical(hash, row);
      scanned += BigInt(batch.rows.length);
      if (!batch.hasMore) break;
      if (batch.lastSourceId === cursor) throw new MigrationError('source-read', 'The source scan did not advance.');
      cursor = batch.lastSourceId;
    }
    if (scanned.toString() !== counts[table]) {
      throw new MigrationError('source-read', 'The projected source inventory does not match the snapshot.');
    }
    canonical(hash, { end: table, scanned: scanned.toString() });
  }
  canonical(hash, await exclusions(client, counts));
  return hash.digest('hex');
}

export function startAssetFingerprint() {
  const hash = stream('assets');
  return {
    observe(entry: VerifiedSourceAsset) { canonical(hash, entry); },
    finish() { return hash.digest('hex'); },
  };
}

function fingerprintComponent(name: string, value: unknown) {
  const hash = stream(name);
  canonical(hash, value);
  return hash.digest('hex');
}

export function finishSourceFingerprint(capture: MigrationCapture, rows: string, assets: string) {
  const components = {
    manifest: fingerprintComponent('manifest', capture),
    catalog: fingerprintComponent('catalog', sourceCatalogMetadata.catalog),
    ledger: fingerprintComponent('ledger', sourceCatalogMetadata.ledger),
    rows,
    assets,
  };
  return { version, sha256: fingerprintComponent('snapshot', { projection: sourceProjectionVersion, ...components }), components } as const;
}

export type SourceFingerprint = ReturnType<typeof finishSourceFingerprint>;
