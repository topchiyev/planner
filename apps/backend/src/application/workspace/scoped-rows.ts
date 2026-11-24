import type { Document } from 'mongodb';
import { canonicalRow, equal, type WorkspaceRecordName, type WorkspaceRecords, type WorkspaceRow } from './records.js';

const queryBatchSize = 512;

export function scopedWorkspaceRows(records: WorkspaceRecords, generationId: string) {
  function find<K extends WorkspaceRecordName>(collection: K, selector: Document, ...checks: Document[]) {
    return records.find(collection, { ...selector, $expr: { $and: [canonicalRow(generationId), ...checks] } }, { id: 1 });
  }
  function exact<K extends WorkspaceRecordName>(collection: K, field: string, id: string) {
    return find(collection, { [field]: id }, equal(field, id));
  }
  async function byIds<K extends WorkspaceRecordName>(collection: K, field: string, ids: string[], selector: Document = {}, ...checks: Document[]) {
    const rows: WorkspaceRow<K>[] = [];
    for (let offset = 0; offset < ids.length; offset += queryBatchSize) {
      const batch = ids.slice(offset, offset + queryBatchSize);
      const matches = await find(collection, { ...selector, [field]: { $in: batch } }, { $in: ['$' + field, batch] }, ...checks);
      for (const match of matches) rows.push(match);
    }
    return rows;
  }
  return { find, exact, byIds };
}
