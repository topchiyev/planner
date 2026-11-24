import { listColorSchema, workspaceBoardView, workspaceCardType, workspaceListKind } from '@planner/contracts';
import type { WorkspaceFields } from '../../storage/scoped.js';
import { nameBasedUuid } from '../../storage/identity.js';
import { gradientPreset, importAccount, importAccountPreferences, importStopwatch, invalidBaseRow, nullableDate, targetTimes } from './base-fields.js';
import type { ImportedEntity, ImportOptionalReference, ImportOrder, ImportProvenance, ImportRecords, ImportReference } from './staged-records.js';
import type { SourceRow } from './source-projections.js';

export const baseWorkspaceTables = ['board', 'card', 'list', 'project', 'user_account'] as const;
export const baseRelationshipTables = ['board_membership', 'project_manager'] as const;
type BaseTable = typeof baseWorkspaceTables[number];
type RelationshipTable = typeof baseRelationshipTables[number];

type SourceReservation<T extends ImportedEntity = ImportedEntity> = { table: T; row: SourceRow<T> };

// The projection row is controlled by its table's pinned decoder. This discriminated union keeps that relationship below.
type Reservation = { [K in ImportedEntity]: SourceReservation<K> }[ImportedEntity];

export async function reserveSourceRecord(store: ImportRecords, untyped: SourceReservation) {
  const { table, row } = untyped as Reservation;
  const provenance: ImportProvenance = { createdAt: row.created_at, updatedAt: row.updated_at };
  let order: ImportOrder | undefined;
  let reference: ImportReference | undefined;
  switch (table) {
    case 'project':
      order = { parent: '', position: 0 };
      provenance.backgroundType = row.background_type;
      provenance.backgroundGradient = row.background_gradient;
      provenance.backgroundReference = await optionalProvenance(store, 'background_image', row.background_image_id, row.id);
      if ((row.background_type === 'gradient' || row.background_gradient !== null)
        && !gradientPreset(row.background_type, row.background_gradient)) provenance.unrecognizedGradient = true;
      break;
    case 'board':
      order = { parent: row.project_id, position: row.position };
      reference = { parent: row.project_id };
      break;
    case 'list':
      reference = { parent: row.board_id, kind: row.type };
      if (row.position !== null) order = { parent: row.board_id, position: row.position };
      break;
    case 'card':
      order = { parent: row.list_id, position: row.position, board: row.board_id, changedAt: row.list_changed_at };
      provenance.dueDate = row.due_date;
      provenance.listChangedAt = row.list_changed_at;
      provenance.previousListSourceId = row.prev_list_id;
      provenance.creatorSourceId = row.creator_user_id;
      provenance.sourceCommentCount = row.comments_total;
      provenance.stopwatchStartedAt = importStopwatch(row.stopwatch).sourceStartedAt;
      provenance.coverReference = await optionalProvenance(store, 'attachment', row.cover_attachment_id, row.id, 'file');
      break;
    case 'project_manager':
      reference = { parent: row.project_id };
      break;
    case 'background_image':
      reference = { parent: row.project_id };
      break;
    case 'attachment':
      reference = { parent: row.card_id, kind: row.type };
      break;
    case 'user_account': {
      const { unsupported } = importAccountPreferences(row);
      if (unsupported.length > 0) provenance.unsupportedPreferences = unsupported;
      break;
    }
  }
  return store.reserve(table, row.id, provenance, order, reference);
}

function requiredName(value: string | null) {
  if (value === null || !value.trim() || value.includes('\0')) invalidBaseRow('The source has an invalid workspace name.');
  return value;
}

function positiveRank(rank: bigint | null) {
  if (rank === null || rank < 1n) invalidBaseRow('The source has an invalid finite placement.');
  return rank;
}

async function scopedOptionalReference(store: ImportRecords, table: 'background_image' | 'attachment',
  sourceId: string | null, parentSourceId: string, kind?: string) {
  if (sourceId === null) return null;
  const source = await store.mapping(table, sourceId);
  if (source && (source.reference?.parent !== parentSourceId || (kind !== undefined && source.reference.kind !== kind))) {
    invalidBaseRow('An optional source reference belongs to a different workspace scope or has an invalid type.');
  }
  return source;
}

async function optionalProvenance(store: ImportRecords, table: 'background_image' | 'attachment', sourceId: string | null,
  parentSourceId: string, kind?: string): Promise<ImportOptionalReference> {
  if (sourceId === null) return null;
  return await scopedOptionalReference(store, table, sourceId, parentSourceId, kind)
    ? { sourceId } : { sourceId, unresolved: 'missing-source-record' };
}

async function scopedReference(store: ImportRecords, table: 'project_manager' | 'list' | 'board', sourceId: string, parentSourceId: string) {
  const source = await store.mapping(table, sourceId);
  if (!source || source.reference?.parent !== parentSourceId) {
    invalidBaseRow('A required source reference is missing or belongs to a different workspace scope.');
  }
  return source;
}

export function writeBaseRow(store: ImportRecords, fallback: string,
  entry: { [K in BaseTable]: SourceReservation<K> }[BaseTable], rank: bigint | null, history: bigint) {
  const id = store.publicId(entry.table, entry.row.id);
  const times = targetTimes(entry.row, fallback);
  switch (entry.table) {
    case 'user_account': {
      const { fields, updatedAt } = importAccount(id, entry.row, fallback);
      return store.writeAccount(id, fields, updatedAt);
    }
    case 'project': return writeProject(store, id, entry.row, { ...times, rank: positiveRank(rank) });
    case 'board': return writeBoard(store, id, entry.row, { ...times, rank: positiveRank(rank), historySequence: history });
    case 'list': return writeList(store, id, entry.row, { ...times, rank });
    case 'card': return writeCard(store, id, entry.row, { ...times, rank, historySequence: history });
  }
}

async function writeProject(store: ImportRecords, id: string, row: SourceRow<'project'>, fields: WorkspaceFields) {
  const owner = row.owner_project_manager_id === null ? null : await scopedReference(store, 'project_manager', row.owner_project_manager_id, row.id);
  if (row.background_type !== null && row.background_type !== 'gradient' && row.background_type !== 'image')
    invalidBaseRow('The source has an invalid project background type.');
  const image = await scopedOptionalReference(store, 'background_image', row.background_image_id, row.id);
  await store.write('projects', id, { ...fields, name: requiredName(row.name), description: row.description, type: owner ? 'private' : 'shared',
    ownerProjectManagerId: owner?.id ?? null, hidden: row.is_hidden, backgroundPreset: gradientPreset(row.background_type, row.background_gradient),
    backgroundId: row.background_type === 'image' ? image?.id ?? null : null, boardOrderVersion: 1, fieldGroupOrderVersion: 1 });
}

async function writeBoard(store: ImportRecords, id: string, row: SourceRow<'board'>, fields: WorkspaceFields) {
  const projectId = await store.require('project', row.project_id);
  const view = workspaceBoardView.safeParse(row.default_view);
  const type = workspaceCardType.safeParse(row.default_card_type);
  if (!view.success || !type.success) invalidBaseRow('The source has invalid board preferences.');
  await store.write('boards', id, { ...fields, projectId, name: requiredName(row.name), defaultView: view.data, orderVersion: 1, fieldGroupOrderVersion: 1 });
  const { createdAt, updatedAt } = fields;
  await store.write('boardPreferences', nameBasedUuid(id, 'board-preferences'), { boardId: id, createdAt, updatedAt,
    defaultView: view.data, defaultCardType: type.data, restrictedCardType: row.limit_card_types_to_default_one ? type.data : null,
    showCreator: row.always_display_card_creator, showCardAge: row.display_card_ages, showCardCount: row.show_card_counter,
    expandChecklists: row.expand_task_lists_by_default });
}

async function writeList(store: ImportRecords, id: string, row: SourceRow<'list'>, fields: WorkspaceFields & { rank: bigint | null }) {
  const boardId = await store.require('board', row.board_id);
  const parsed = workspaceListKind.safeParse(row.type);
  const color = listColorSchema.nullable().safeParse(row.color);
  if (!parsed.success || !color.success) invalidBaseRow('The source has an invalid list type or color.');
  const kind = parsed.data;
  const system = kind === 'archive' || kind === 'trash';
  if (system !== (fields.rank === null)) invalidBaseRow('The source has an invalid system list or finite placement.');
  const name = system ? { archive: 'Archive', trash: 'Trash' }[kind] : requiredName(row.name);
  await store.write('lists', id, { ...fields, boardId, name, kind, color: color.data, orderVersion: 1 });
}

async function writeCard(store: ImportRecords, id: string, row: SourceRow<'card'>, fields: WorkspaceFields & { rank: bigint | null }) {
  const boardId = await store.require('board', row.board_id);
  const list = await scopedReference(store, 'list', row.list_id, row.board_id);
  const parsed = workspaceListKind.safeParse(list.reference?.kind);
  const type = workspaceCardType.safeParse(row.type);
  if (!parsed.success || !type.success) invalidBaseRow('The source has an invalid card type or placement.');
  const kind = parsed.data === 'archive' || parsed.data === 'trash' ? parsed.data : 'board';
  if ((kind === 'board') !== (fields.rank !== null)) invalidBaseRow('The source has an invalid card placement rank.');
  const previous = row.prev_list_id === null ? null : await store.mapping('list', row.prev_list_id);
  const previousReference = previous?.reference;
  const previousListId = previous && previousReference?.parent === row.board_id
    && (previousReference.kind === 'active' || previousReference.kind === 'closed') ? previous.id : null;
  const creatorId = row.creator_user_id === null ? null : await store.resolve('user_account', row.creator_user_id);
  const cover = await scopedOptionalReference(store, 'attachment', row.cover_attachment_id, row.id, 'file');
  await store.write('cards', id, { ...fields, boardId, listId: list.id, kind, type: type.data, name: requiredName(row.name),
    closed: row.is_closed, description: row.description, dueDate: nullableDate(row.due_date), dueDateCompleted: row.is_due_completed,
    stopwatch: importStopwatch(row.stopwatch).value, listChangedAt: nullableDate(row.list_changed_at), previousListId, creatorId,
    coverAttachmentId: cover?.id ?? null, checklistOrderVersion: 1, fieldGroupOrderVersion: 1 });
}

export async function writeBaseRelationship(store: ImportRecords, fallback: string,
  entry: { [K in RelationshipTable]: SourceReservation<K> }[RelationshipTable]) {
  const { table, row } = entry;
  const id = store.publicId(table, row.id);
  const userId = await store.require('user_account', row.user_id);
  const projectId = await store.require('project', row.project_id);
  const times = targetTimes(row, fallback);
  if (table === 'project_manager') return store.write('projectManagers', id, { ...times, userId, projectId });
  const board = await scopedReference(store, 'board', row.board_id, row.project_id);
  if (row.role !== 'editor' && (row.role !== 'viewer' || row.can_comment === null))
    invalidBaseRow('The source has an invalid board member role or comment grant.');
  return store.write('boardMembers', id, { ...times, boardId: board.id, userId, role: row.role,
    canComment: row.role === 'viewer' ? row.can_comment : null });
}
