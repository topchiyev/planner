import { signedInt64TextSchema, sourceAssetIdSchema } from '@planner/contracts/storage';
import type { Client } from 'pg';
import { MigrationError } from './manifest.js';
import { sourceTables } from './source-catalog.js';

// Each projection is an explicit column allowlist for the catalog shared by both supported releases.
export const sourceProjectionVersion = 1;
export const maximumSourceBatch = 256;
const maximumRowBytes = 2 * 1024 * 1024;
const maximumBatchBytes = 8 * 1024 * 1024;

type Scalar = 'int64' | 'int32' | 'text' | 'upload' | 'utc' | 'position' | 'boolean' | 'json';
type Field = Scalar | `${Scalar}?`;

const columns = {
  action: { id: 'int64', card_id: 'int64', user_id: 'int64?', type: 'text', data: 'json', created_at: 'utc?',
    updated_at: 'utc?', board_id: 'int64?', },
  attachment: { id: 'int64', card_id: 'int64', creator_user_id: 'int64?', type: 'text', data: 'json',
    name: 'text', created_at: 'utc?', updated_at: 'utc?', },
  background_image: { id: 'int64', project_id: 'int64', uploaded_file_id: 'upload', extension: 'text',
    size: 'int64', created_at: 'utc?', updated_at: 'utc?', },
  base_custom_field_group: { id: 'int64', project_id: 'int64', name: 'text', created_at: 'utc?',
    updated_at: 'utc?', },
  board: { id: 'int64', project_id: 'int64', position: 'position', name: 'text', default_view: 'text',
    default_card_type: 'text', limit_card_types_to_default_one: 'boolean',
    always_display_card_creator: 'boolean', created_at: 'utc?', updated_at: 'utc?',
    expand_task_lists_by_default: 'boolean', display_card_ages: 'boolean', show_card_counter: 'boolean', },
  board_membership: { id: 'int64', project_id: 'int64', board_id: 'int64', user_id: 'int64', role: 'text',
    can_comment: 'boolean?', created_at: 'utc?', updated_at: 'utc?', },
  board_subscription: { id: 'int64', board_id: 'int64', user_id: 'int64', created_at: 'utc?',
    updated_at: 'utc?', },
  card: { id: 'int64', board_id: 'int64', list_id: 'int64', creator_user_id: 'int64?', prev_list_id: 'int64?',
    cover_attachment_id: 'int64?', type: 'text', position: 'position?', name: 'text', description: 'text?',
    due_date: 'utc?', stopwatch: 'json?', created_at: 'utc?', updated_at: 'utc?', list_changed_at: 'utc?',
    comments_total: 'int32', is_closed: 'boolean', is_due_completed: 'boolean?', },
  card_label: { id: 'int64', card_id: 'int64', label_id: 'int64', created_at: 'utc?', updated_at: 'utc?', },
  card_membership: { id: 'int64', card_id: 'int64', user_id: 'int64', created_at: 'utc?', updated_at: 'utc?', },
  card_subscription: { id: 'int64', card_id: 'int64', user_id: 'int64', is_permanent: 'boolean',
    created_at: 'utc?', updated_at: 'utc?', },
  comment: { id: 'int64', card_id: 'int64', user_id: 'int64?', text: 'text', created_at: 'utc?',
    updated_at: 'utc?', },
  custom_field: { id: 'int64', base_custom_field_group_id: 'int64?', custom_field_group_id: 'int64?',
    position: 'position', name: 'text', show_on_front_of_card: 'boolean', created_at: 'utc?',
    updated_at: 'utc?', },
  custom_field_group: { id: 'int64', board_id: 'int64?', card_id: 'int64?',
    base_custom_field_group_id: 'int64?', position: 'position', name: 'text?', created_at: 'utc?',
    updated_at: 'utc?', },
  custom_field_value: { id: 'int64', card_id: 'int64', custom_field_group_id: 'int64', custom_field_id: 'int64',
    content: 'text', created_at: 'utc?', updated_at: 'utc?', },
  internal_config: { id: 'int64', storage_limit: 'text?', active_users_limit: 'int32?',
    is_initialized: 'boolean', created_at: 'utc?', updated_at: 'utc?', },
  label: { id: 'int64', board_id: 'int64', position: 'position', name: 'text?', color: 'text',
    created_at: 'utc?', updated_at: 'utc?', },
  list: { id: 'int64', board_id: 'int64', type: 'text', position: 'position?', name: 'text?', color: 'text?',
    created_at: 'utc?', updated_at: 'utc?', },
  notification: { id: 'int64', user_id: 'int64', creator_user_id: 'int64?', board_id: 'int64', card_id: 'int64',
    comment_id: 'int64?', action_id: 'int64?', type: 'text', data: 'json', is_read: 'boolean',
    created_at: 'utc?', updated_at: 'utc?', },
  project: { id: 'int64', owner_project_manager_id: 'int64?', background_image_id: 'int64?', name: 'text',
    description: 'text?', background_type: 'text?', background_gradient: 'text?', is_hidden: 'boolean',
    created_at: 'utc?', updated_at: 'utc?', },
  project_favorite: { id: 'int64', project_id: 'int64', user_id: 'int64', created_at: 'utc?',
    updated_at: 'utc?', },
  project_manager: { id: 'int64', project_id: 'int64', user_id: 'int64', created_at: 'utc?', updated_at: 'utc?', },
  storage_usage: { id: 'int64', total: 'int64', user_avatars: 'int64', background_images: 'int64',
    attachments: 'int64', created_at: 'utc?', updated_at: 'utc?', },
  task: { id: 'int64', task_list_id: 'int64', assignee_user_id: 'int64?', position: 'position', name: 'text',
    is_completed: 'boolean', created_at: 'utc?', updated_at: 'utc?', linked_card_id: 'int64?', },
  task_list: { id: 'int64', card_id: 'int64', position: 'position', name: 'text',
    show_on_front_of_card: 'boolean', created_at: 'utc?', updated_at: 'utc?', hide_completed_tasks: 'boolean', },
  uploaded_file: { id: 'upload', references_total: 'int32?', created_at: 'utc?', updated_at: 'utc?',
    type: 'text', mime_type: 'text?', size: 'int64', },
  user_account: { id: 'int64', email: 'text', role: 'text', name: 'text', username: 'text?', avatar: 'json?',
    phone: 'text?', organization: 'text?', language: 'text?', subscribe_to_own_cards: 'boolean',
    subscribe_to_card_when_commenting: 'boolean', turn_off_recent_card_highlighting: 'boolean',
    enable_favorites_by_default: 'boolean', default_editor_mode: 'text', default_home_view: 'text',
    default_projects_order: 'text', is_deactivated: 'boolean', created_at: 'utc?', updated_at: 'utc?',
    is_totp_enabled: 'boolean', auto_logout_mode: 'text', },
} as const satisfies Record<string, Record<string, Field>>;

export type SourceTable = keyof typeof columns;
export const projectedSourceTables = Object.freeze(Object.keys(columns).sort() as SourceTable[]);
export const excludedSourceTables = Object.freeze(sourceTables.filter((table) => !Object.hasOwn(columns, table)));

export class SourceJsonNumber {
  constructor(readonly decimal: string) {}
}
export type SourceJson = null | boolean | string | SourceJsonNumber | SourceJson[] | { [key: string]: SourceJson };
export function sourceProjection(table: SourceTable) {
  return { version: 1, order: table === 'uploaded_file' ? 'text-C' : 'signed-int64', columns: columns[table] } as const;
}

export type SourceJsonColumn = { readonly value: SourceJson };
type Decoded<K extends Field> = K extends `${infer Base extends Scalar}?` ? Decoded<Base> | null
  : K extends 'int32' | 'position' ? number : K extends 'boolean' ? boolean : K extends 'json' ? SourceJsonColumn : string;
export type SourceRow<T extends SourceTable> = { readonly [K in keyof (typeof columns)[T]]:
  (typeof columns)[T][K] extends Field ? Decoded<(typeof columns)[T][K]> : never };
export type SourceBatch<T extends SourceTable> = { rows: SourceRow<T>[]; lastSourceId: string | null; hasMore: boolean };

function invalid() { return new MigrationError('source-read', 'The source contains an invalid or oversized projected value.'); }
const integer = /^(?:0|-?[1-9][0-9]*)$/u;
const exactInstant = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u;
const jsonId = /(?:^id$|Id$)/u;

export function sourceKey(table: SourceTable, value: unknown) {
  const schema = table === 'uploaded_file' ? sourceAssetIdSchema : signedInt64TextSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function decodeJson(raw: string): SourceJsonColumn {
  try {
    const value = JSON.parse(raw, (key, item: unknown, context?: { source?: string }) => {
      if (item !== null && jsonId.test(key)) {
        return sourceKey(key === 'uploadedFileId' ? 'uploaded_file' : 'card', typeof item === 'number' ? context?.source : item);
      }
      if (typeof item === 'number') {
        if (!context?.source) throw invalid();
        return new SourceJsonNumber(context.source);
      }
      return item;
    }) as SourceJson;
    return { value };
  } catch { throw invalid(); }
}

export function sourceUtcInstant(value: string) {
  if (!exactInstant.test(value) || value.startsWith('0000-')) throw invalid();
  const milliseconds = value.slice(0, 23) + 'Z';
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== milliseconds) throw invalid();
  return value;
}

function decode(field: Field, value: unknown) {
  if (value === null && field.endsWith('?')) return null;
  if (typeof value !== 'string') throw invalid();
  const kind = field.replace(/\?$/u, '') as Scalar;
  switch (kind) {
    case 'text': return value;
    case 'int64': return sourceKey('card', value);
    case 'upload': return sourceKey('uploaded_file', value);
    case 'utc': return sourceUtcInstant(value);
    case 'json': return decodeJson(value);
    case 'boolean':
      if (value === 'true' || value === 'false') return value === 'true';
      break;
    case 'int32': {
      const number = Number(value);
      if (integer.test(value) && number >= -2147483648 && number <= 2147483647) return number;
      break;
    }
    case 'position': {
      if (!/^[0-9a-f]{16}$/u.test(value)) break;
      const number = Buffer.from(value, 'hex').readDoubleBE();
      if (Number.isFinite(number)) return number;
      break;
    }
  }
  throw invalid();
}

function fieldSql(column: string, field: Field) {
  const name = 'src."' + column + '"';
  if (field === 'position' || field === 'position?') return `pg_catalog.encode(pg_catalog.float8send(${name}), 'hex')`;
  if (field !== 'utc' && field !== 'utc?') return name + '::text';
  return `CASE WHEN ${name} >= TIMESTAMP '0001-01-01' AND ${name} < TIMESTAMP '10000-01-01'
    THEN pg_catalog.to_char(${name}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    WHEN ${name} IS NOT NULL THEN 'invalid' END`;
}

export async function readSourceBatch<T extends SourceTable>(client: Client, table: T, lastSourceId: string | null,
  limit: number): Promise<SourceBatch<T>> {
  if (!Object.hasOwn(columns, table) || !Number.isSafeInteger(limit) || limit < 1 || limit > maximumSourceBatch) throw invalid();
  const fields = Object.entries(columns[table]) as [string, Field][];
  const parameters: (number | string)[] = [limit, maximumBatchBytes, maximumRowBytes];
  const collation = table === 'uploaded_file' ? ' COLLATE "C"' : '';
  const where = lastSourceId === null ? '' : `WHERE src.id${collation} > $4::${table === 'uploaded_file' ? 'text' : 'bigint'}${collation}`;
  if (lastSourceId !== null) parameters.push(sourceKey(table, lastSourceId));
  const result = await client.query<{ key: string; payload: string | null; bytes: number }>(`
    WITH encoded AS MATERIALIZED (
      SELECT src.id AS key, pg_catalog.json_build_array(${fields.map(([name, field]) => fieldSql(name, field)).join(', ')} )::text AS payload
      FROM public."${table}" AS src
      ${where}
      ORDER BY src.id${collation} LIMIT $1::integer
    ), sized AS (
      SELECT key, payload, pg_catalog.octet_length(payload) AS bytes,
        sum(pg_catalog.octet_length(payload)) OVER (ORDER BY key${collation}) AS running
      FROM encoded
    )
    SELECT key::text, bytes, CASE WHEN running <= $2::integer AND bytes <= $3::integer THEN payload END AS payload
    FROM sized ORDER BY sized.key${collation}
  `, parameters);
  const rows: SourceRow<T>[] = [];
  let after = lastSourceId;
  let hasMore = result.rows.length === limit;
  for (const { key, payload, bytes } of result.rows) {
    if (!Number.isInteger(bytes) || bytes > maximumRowBytes) throw invalid();
    if (payload === null) { hasMore = true; break; }
    const value = JSON.parse(payload) as unknown;
    if (!Array.isArray(value) || value.length !== fields.length) throw invalid();
    const row = Object.fromEntries(fields.map(([name, field], index) => [name, decode(field, value[index])]));
    const exact = sourceKey(table, key);
    if (exact !== row.id || (after !== null && compareSourceKeys(table, exact, after) <= 0)) throw invalid();
    rows.push(row as SourceRow<T>);
    after = exact;
  }
  return { rows, lastSourceId: after, hasMore };
}

export function compareSourcePosition(first: { id: string; position: number | null }, second: typeof first) {
  if (first.position === null || second.position === null) {
    if (first.position !== second.position) return first.position === null ? 1 : -1;
  } else if (first.position !== second.position) return first.position < second.position ? -1 : 1;
  return compareNumericSourceId(first.id, second.id);
}

export function compareSourceKeys(table: SourceTable, first: string, second: string) {
  return table === 'uploaded_file' ? Buffer.compare(Buffer.from(sourceKey(table, first)), Buffer.from(sourceKey(table, second)))
    : compareNumericSourceId(first, second);
}

function compareNumericSourceId(first: string, second: string) {
  const a = BigInt(sourceKey('card', first));
  const b = BigInt(sourceKey('card', second));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSourceHistory(first: { id: string; list_changed_at: string | null }, second: typeof first) {
  const a = first.list_changed_at === null ? '' : sourceUtcInstant(first.list_changed_at);
  const b = second.list_changed_at === null ? '' : sourceUtcInstant(second.list_changed_at);
  return a === b ? compareNumericSourceId(second.id, first.id) : a > b ? -1 : 1;
}
