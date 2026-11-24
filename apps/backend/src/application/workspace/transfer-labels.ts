import { randomUUID } from 'node:crypto';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { scopedLabels } from './label-state.js';
import { planRankChange, type RankedRow } from './ordered-ranks.js';
import { together, type WorkspaceRecords } from './records.js';
import { rowRevision, touchRevision } from './relationship-policy.js';
import { scopedWorkspaceRows } from './scoped-rows.js';

export interface CardTransferIdentity { sourceId: string; destinationId: string }

function labelKey(row: { name?: string | null; color?: string | null }) {
  const name = row.name?.normalize('NFKC').trim().toLowerCase();
  return name ? 'name/' + name : 'color/' + (row.color ?? '');
}

export async function planTransferLabels(records: WorkspaceRecords, sourceBoard: string, destinationBoard: string,
  cards: CardTransferIdentity[], { generationId, timestamp }: CommandPlanningContext, duplicate: boolean) {
  const { byIds } = scopedWorkspaceRows(records, generationId);
  const links = await byIds('cardLabels', 'cardId', cards.map(({ sourceId }) => sourceId));
  if (!links.length) return { effects: [], remapped: 0, created: 0 };
  const labels = await together([
    scopedLabels(records, generationId, sourceBoard, [...new Set(links.map(({ labelId }) => labelId))]),
    scopedLabels(records, generationId, destinationBoard),
  ]);
  const [source, destination] = labels;
  const destinationByKey = new Map<string, string>();
  for (const row of destination) {
    const key = labelKey(row);
    if (!destinationByKey.has(key)) destinationByKey.set(key, row.id);
  }

  const appended = [];
  const order: RankedRow[] = destination.map(({ id, rank }) => ({ id, rank: rank == null ? null : decodeRank(rank) }));
  const bySourceId = new Map<string, string>();
  for (const row of source) {
    const key = labelKey(row);
    let id = sourceBoard === destinationBoard ? row.id : destinationByKey.get(key);
    if (!id) {
      id = randomUUID();
      const rankChanges = new Map(planRankChange(order, id, null).map(({ id: movedId, rank }) => [movedId, rank]));
      for (const current of order) current.rank = rankChanges.get(current.id) ?? current.rank;
      order.push({ id, rank: rankChanges.get(id)! });
      destinationByKey.set(key, id);
      appended.push({ id, name: row.name ?? null, color: row.color ?? null });
    }
    bySourceId.set(row.id, id);
  }

  const ranks = new Map(order.map(({ id, rank }) => [id, rank]));
  const effects: PlannedEffect[] = [];
  for (const row of destination) {
    const old = row.rank == null ? null : decodeRank(row.rank);
    const rank = ranks.get(row.id);
    if (rank == null || rank === old) continue;
    const touch = touchRevision('labels', row, timestamp);
    effects.push({ ...touch, fields: { ...touch.fields, rank: rank.toString() } });
  }
  for (const { id, ...fields } of appended) {
    effects.push({ kind: 'insert', collection: 'labels', id, fields: {
      ...fields, boardId: destinationBoard, rank: ranks.get(id)!.toString(), createdAt: timestamp, updatedAt: null,
    } });
  }

  const byCard = new Map<string, typeof links>();
  for (const link of links) {
    const rows = byCard.get(link.cardId) ?? [];
    rows.push(link);
    byCard.set(link.cardId, rows);
  }
  const linkDeletes: PlannedEffect[] = [];
  const linkUpdates: PlannedEffect[] = [];
  for (const { sourceId, destinationId } of cards) {
    const keep = new Set<string>();
    for (const link of byCard.get(sourceId) ?? []) {
      const labelId = bySourceId.get(link.labelId);
      if (!labelId || keep.has(labelId)) {
        if (!duplicate) linkDeletes.push({ kind: 'delete', collection: 'cardLabels', id: link.id, revision: rowRevision(link) });
        continue;
      }
      keep.add(labelId);
      linkUpdates.push(duplicate
        ? { kind: 'insert', collection: 'cardLabels', id: randomUUID(), fields: { cardId: destinationId, labelId, createdAt: timestamp } }
        : { kind: 'update', collection: 'cardLabels', id: link.id, revision: rowRevision(link), fields: { labelId, updatedAt: timestamp } });
    }
  }
  return { effects: [...effects, ...linkDeletes, ...linkUpdates], remapped: linkUpdates.length, created: appended.length };
}
