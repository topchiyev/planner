import { performance } from 'node:perf_hooks';
import { MongoServerError, type Document } from 'mongodb';
import { RE2JS, RE2JSSyntaxException } from 're2js';
import type { WorkspaceRecords } from './records.js';

const scanLimits = { bytes: 32 * 1024 * 1024, cards: 25_000, milliseconds: 1500 };

type FieldMatch = (title: string, description: string) => boolean;
type Search = { valid: false } | { valid: true; binding: string; match?: FieldMatch };

const fold = (value: string) => value.normalize('NFC').toLowerCase();

export function compileCardSearch(query: string): Search {
  if (query.length >= 2 && query.startsWith('/') && query.endsWith('/')) {
    if (query.length === 2) return { valid: false };
    try {
      const pattern = RE2JS.compile(query.slice(1, -1), RE2JS.CASE_INSENSITIVE);
      return { valid: true, binding: JSON.stringify(['pattern', query]),
        match: (title, description) => pattern.test(title) || pattern.test(description) };
    } catch (error) {
      if (error instanceof RE2JSSyntaxException) return { valid: false };
      throw error;
    }
  }
  const terms = [...new Set(fold(query).split(/[\s,;]+/u).filter(Boolean))].sort();
  const binding = JSON.stringify(['literal', terms]);
  if (!terms.length) return { valid: true, binding };
  return { valid: true, binding, match(title, description) {
    const name = fold(title);
    const body = fold(description);
    return terms.every((term) => name.includes(term) || body.includes(term));
  } };
}

export async function scanCardSearch(
  records: WorkspaceRecords, filter: Document, selection: Document[], match: FieldMatch,
) {
  const deadline = performance.now() + scanLimits.milliseconds;
  let bytes = 0;
  let scanned = 0;
  const ids = [];
  const cursor = records.scan<{ id: string; name?: string; description?: string | null }>('cards', filter,
    [...selection, { $project: { _id: 0, id: 1, name: 1, description: 1 } }],
    { batchSize: 64, maxTimeMS: scanLimits.milliseconds });
  try {
    for await (const row of cursor) {
      if (++scanned > scanLimits.cards || performance.now() >= deadline) return null;
      const title = typeof row.name === 'string' ? row.name : '';
      const description = typeof row.description === 'string' ? row.description : '';
      bytes += Buffer.byteLength(title) + Buffer.byteLength(description);
      if (bytes > scanLimits.bytes) return null;
      if (match(title, description)) ids.push(row.id);
      if (performance.now() >= deadline) return null;
    }
    return ids;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 50) return null;
    throw error;
  } finally { await cursor.close(); }
}
