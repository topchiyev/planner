import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { assertBoardSystemLists, boardHistoryHighWater, openBaseOrder } from './base-order.js';
import { invalidBaseRow } from './base-fields.js';
import { baseRelationshipTables, baseWorkspaceTables, reserveSourceRecord, writeBaseRelationship, writeBaseRow } from './base-workspace.js';
import { importRunKey, migrationPasses, sealMigrationStage, writeMigrationBatch, type ImportIdentity, type ImportRun, type MigrationCheckpoint, type MigrationPosition,
  type migrationCursors } from './checkpoint.js';
import { discussionTables, writeImportedDiscussion } from './discussion-stage.js';
import { MigrationError } from './manifest.js';
import { createMigrationMediaStage, migrationMediaTables, type MigrationMediaRow, type MigrationMediaTarget } from './media-stage.js';
import { assertVerifiedSourceSnapshot, type VerifiedSourceSnapshot } from './preflight.js';
import { maximumSourceBatch, projectedSourceTables } from './source-projections.js';
import { openImportRecords, type ImportedEntity, type ImportRecords } from './staged-records.js';
import { relationshipRankTables, workspaceRelationshipTables, writeWorkspaceRelationship } from './workspace-relationships.js';

const reservable = (table: typeof projectedSourceTables[number]): table is ImportedEntity => table !== 'internal_config' && table !== 'storage_usage';
const stageTables = [
  { pass: 'reserve', tables: projectedSourceTables.filter(reservable) },
  { pass: 'base', tables: baseWorkspaceTables },
  { pass: 'edges', tables: baseRelationshipTables },
  { pass: 'deferred', tables: workspaceRelationshipTables },
  { pass: 'projections', tables: discussionTables },
  { pass: 'media', tables: migrationMediaTables },
] as const;
const rankTables = new Set(['project', 'board', 'list', 'card', ...relationshipRankTables]);

/** Stage the account and core workspace graph without enabling access or producing domain events. */
export async function stageBaseWorkspace(db: Db, lease: WriterLease, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  cursors: ReturnType<typeof migrationCursors>, batchSize = maximumSourceBatch) {
  return stageWorkspace(db, lease, identity, snapshot, cursors, batchSize);
}

/** Stage the complete inactive graph and its verified private media. */
export function stageMigrationWorkspace(db: Db, lease: WriterLease, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  cursors: ReturnType<typeof migrationCursors>, mediaTarget: MigrationMediaTarget, batchSize = maximumSourceBatch) {
  return stageWorkspace(db, lease, identity, snapshot, cursors, batchSize, mediaTarget);
}

async function stageWorkspace(db: Db, lease: WriterLease, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  cursors: ReturnType<typeof migrationCursors>, batchSize: number, mediaTarget?: MigrationMediaTarget): Promise<MigrationCheckpoint | null> {
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot);
  if (!isDeepStrictEqual(snapshot.fingerprint, identity.fingerprint))
    throw new MigrationError('source-changed', 'The source snapshot changed. Start a new import run.');
  const run = await db.collection<ImportRun>('importRuns').findOne(importRunKey(identity));
  if (!run || (run.state !== 'preflighted' && run.state !== 'staging') || !isDeepStrictEqual(run.fingerprint, identity.fingerprint)
    || run.source.instanceId !== snapshot.capture.sourceInstanceId) {
    throw new MigrationError('target-write', 'The protected import run does not match the verified snapshot.');
  }
  if (mediaTarget && run.manifestSha256 !== snapshot.manifestSha256)
    throw new MigrationError('source-changed', 'The source capture manifest changed. Start a new import run.');
  const { generationId } = identity;
  const records = await openImportRecords(db, lease, identity, run.source.instanceId);
  const stageMedia = mediaTarget && createMigrationMediaStage(records, snapshot, lease, mediaTarget);
  let checkpoint = run.checkpoint;
  if (checkpoint && cursors.open({ runId: run.id, generationId, fingerprint: identity.fingerprint.sha256,
    pass: checkpoint.pass, table: checkpoint.table }, checkpoint.token) !== checkpoint.lastSourceId) {
    throw new MigrationError('target-write', 'The protected import run has an invalid cursor.');
  }
  if (run.stageCompletion !== undefined) {
    cursors.assertComplete(run);
    return checkpoint;
  }
  await walkMigrationStage(db, identity, snapshot, batchSize, records, stageMedia, {
    checkpoint: () => checkpoint,
    async batch(position, apply) {
      mediaTarget?.signal?.throwIfAborted();
      checkpoint = await writeMigrationBatch(lease, db, identity, snapshot, cursors, checkpoint, position, async () => {
        await apply();
        mediaTarget?.signal?.throwIfAborted();
      });
    },
    row(_position, _sourceId, apply) { mediaTarget?.signal?.throwIfAborted(); return apply(); },
  });
  if (mediaTarget) {
    mediaTarget.signal?.throwIfAborted();
    await sealMigrationStage(lease, db, identity, snapshot, cursors, checkpoint);
  }
  return checkpoint;
}

type StageWalk = {
  checkpoint(): MigrationCheckpoint | null;
  batch(position: MigrationPosition, apply: () => Promise<void>): Promise<void>;
  row(position: MigrationPosition, sourceId: string, apply: () => Promise<void>): Promise<void>;
};

export { completedMigrationTable } from './checkpoint.js';
export const reservableSourceTable = reservable;

export async function walkMigrationStage(db: Db, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  batchSize: number, records: ImportRecords, stageMedia: ReturnType<typeof createMigrationMediaStage> | undefined, walk: StageWalk) {
  const { generationId } = identity;
  const { capturedAt } = snapshot.capture;
  for (const { pass, tables } of stageTables) {
    if (pass === 'media' && !stageMedia) break;
    for (const table of tables) {
      const checkpoint = walk.checkpoint();
      const previous = checkpoint && (migrationPasses.indexOf(checkpoint.pass) - migrationPasses.indexOf(pass)
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
          const position = { pass, table, lastSourceId: batch.lastSourceId };
          await walk.batch(position, async () => {
            for (const row of batch.rows) {
              await walk.row(position, row.id, async () => {
                if (pass === 'reserve') {
                  await reserveSourceRecord(records, { table, row });
                } else if (pass === 'edges') {
                  await writeBaseRelationship(records, capturedAt, { table, row } as Parameters<typeof writeBaseRelationship>[2]);
                } else if (pass === 'deferred') {
                  await writeWorkspaceRelationship(records, capturedAt, { table, row } as Parameters<typeof writeWorkspaceRelationship>[2],
                    await rank?.take(row.id) ?? null);
                } else if (pass === 'media') {
                  if (!stageMedia) throw new MigrationError('target-write', 'The private migration media target is unavailable.');
                  await stageMedia({ table, row } as MigrationMediaRow);
                } else if (pass === 'projections') {
                  await writeImportedDiscussion(records, identity.runId, capturedAt, { table, row } as Parameters<typeof writeImportedDiscussion>[3]);
                } else {
                  if (table === 'board') await assertBoardSystemLists(db, generationId, row.id);
                  const position = await rank?.take(row.id) ?? null;
                  const sequence = table === 'board' ? await boardHistoryHighWater(db, generationId, row.id)
                    : await history?.take(row.id) ?? null;
                  if (table === 'card' && sequence === null) invalidBaseRow('The staged card history does not match the verified source.');
                  await writeBaseRow(records, capturedAt, { table, row } as Parameters<typeof writeBaseRow>[2], position, sequence ?? 0n);
                }
              });
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
}
