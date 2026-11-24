import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { assertBoardSystemLists, boardHistoryHighWater, openBaseOrder } from './base-order.js';
import { invalidBaseRow } from './base-fields.js';
import { baseRelationshipTables, baseWorkspaceTables, reserveSourceRecord, writeBaseRelationship, writeBaseRow } from './base-workspace.js';
import { importRunKey, writeMigrationBatch, type ImportIdentity, type ImportRun, type MigrationCheckpoint,
  type migrationCursors } from './checkpoint.js';
import { MigrationError } from './manifest.js';
import { assertVerifiedSourceSnapshot, type VerifiedSourceSnapshot } from './preflight.js';
import { maximumSourceBatch, projectedSourceTables } from './source-projections.js';
import { openImportRecords, type ImportedEntity } from './staged-records.js';
import { relationshipRankTables, workspaceRelationshipTables, writeWorkspaceRelationship } from './workspace-relationships.js';

const reservable = (table: typeof projectedSourceTables[number]): table is ImportedEntity => table !== 'internal_config' && table !== 'storage_usage';
const stageTables = [
  { pass: 'reserve', tables: projectedSourceTables.filter(reservable) },
  { pass: 'base', tables: baseWorkspaceTables },
  { pass: 'edges', tables: baseRelationshipTables },
  { pass: 'deferred', tables: workspaceRelationshipTables },
] as const;
const rankTables = new Set(['project', 'board', 'list', 'card', ...relationshipRankTables]);
const passOrdinal = ['reserve', 'base', 'edges', 'deferred', 'projections'];

/** Stage the account and core workspace graph without enabling access or producing domain events. */
export async function stageBaseWorkspace(db: Db, lease: WriterLease, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  cursors: ReturnType<typeof migrationCursors>, batchSize = maximumSourceBatch): Promise<MigrationCheckpoint | null> {
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot);
  if (!isDeepStrictEqual(snapshot.fingerprint, identity.fingerprint))
    throw new MigrationError('source-changed', 'The source snapshot changed. Start a new import run.');
  const run = await db.collection<ImportRun>('importRuns').findOne(importRunKey(identity));
  if (!run || (run.state !== 'preflighted' && run.state !== 'staging') || !isDeepStrictEqual(run.fingerprint, identity.fingerprint)
    || run.source.instanceId !== snapshot.capture.sourceInstanceId) {
    throw new MigrationError('target-write', 'The protected import run does not match the verified snapshot.');
  }
  const { generationId } = identity;
  const records = await openImportRecords(db, lease, identity, run.source.instanceId);
  const { capturedAt } = snapshot.capture;
  let checkpoint = run.checkpoint;
  if (checkpoint && cursors.open({ runId: run.id, generationId, fingerprint: identity.fingerprint.sha256,
    pass: checkpoint.pass, table: checkpoint.table }, checkpoint.token) !== checkpoint.lastSourceId) {
    throw new MigrationError('target-write', 'The protected import run has an invalid cursor.');
  }

  for (const { pass, tables } of stageTables) {
    for (const table of tables) {
      const previous = checkpoint && (passOrdinal.indexOf(checkpoint.pass) - passOrdinal.indexOf(pass)
        || projectedSourceTables.indexOf(checkpoint.table) - projectedSourceTables.indexOf(table));
      if (previous !== null && (previous > 0 || (previous === 0 && checkpoint?.lastSourceId === null))) continue;
      let after = previous === 0 ? checkpoint?.lastSourceId ?? null : null;
      const rank = (pass === 'base' || pass === 'deferred') && rankTables.has(table)
        ? openBaseOrder(db, generationId, table as Parameters<typeof openBaseOrder>[2], after, 'rank') : null;
      const history = pass === 'base' && table === 'card' ? openBaseOrder(db, generationId, table, after, 'history') : null;
      try {
        let hasMore = true;
        while (hasMore) {
          const batch = await snapshot.readBatch(table, after, batchSize);
          hasMore = batch.hasMore;
          if (batch.rows.length === 0 && after !== null) break;
          if (hasMore && batch.lastSourceId === after) invalidBaseRow('The verified source cursor did not advance.');
          checkpoint = await writeMigrationBatch(lease, db, identity, snapshot, cursors,
            checkpoint, { pass, table, lastSourceId: batch.lastSourceId }, async () => {
              for (const row of batch.rows) {
                if (pass === 'reserve') {
                  await reserveSourceRecord(records, { table, row });
                } else if (pass === 'edges') {
                  await writeBaseRelationship(records, capturedAt, { table, row } as Parameters<typeof writeBaseRelationship>[2]);
                } else if (pass === 'deferred') {
                  await writeWorkspaceRelationship(records, capturedAt, { table, row } as Parameters<typeof writeWorkspaceRelationship>[2],
                    await rank?.take(row.id) ?? null);
                } else {
                  if (table === 'board') await assertBoardSystemLists(db, generationId, row.id);
                  const position = await rank?.take(row.id) ?? null;
                  const sequence = table === 'board' ? await boardHistoryHighWater(db, generationId, row.id)
                    : await history?.take(row.id) ?? null;
                  if (table === 'card' && sequence === null) invalidBaseRow('The staged card history does not match the verified source.');
                  await writeBaseRow(records, capturedAt, { table, row } as Parameters<typeof writeBaseRow>[2], position, sequence ?? 0n);
                }
              }
              if (!hasMore) {
                await rank?.complete();
                await history?.complete();
              }
            });
          after = batch.lastSourceId;
        }
      } finally {
        await Promise.all([rank?.close(), history?.close()]);
      }
    }
  }
  return checkpoint;
}
