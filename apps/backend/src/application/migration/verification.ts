import { createSecretKey, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';
import { workspaceCollections, type WorkspaceCollection } from '../../storage/catalog.js';
import { nameBasedUuid } from '../../storage/identity.js';
import { MediaStorageError, type BlobIdentity, type PrivateMediaStore } from '../../storage/blobs/private-store.js';
import { BackupError } from '../backup/archive.js';
import type { WriterLease } from '../command-gate/writer-lease.js';
import { createBoardEventCursors } from '../board-events/cursor.js';
import type { MediaDecoder } from '../media/decoder.js';
import { MediaRejection } from '../media/errors.js';
import { availableMedia, catalogVariants, mediaRecords } from '../media/records.js';
import { createWorkspaceAuthorization, WorkspaceAccessError } from '../workspace/authorization.js';
import { createWorkspaceReads } from '../workspace/reads.js';
import type { WorkspaceRow } from '../workspace/records.js';
import { canonicalMissingOriginals, type MissingOriginal } from './approval.js';
import { importRunKey, type ImportIdentity, type ImportRun, type migrationCursors } from './checkpoint.js';
import { MigrationError, sha256 } from './manifest.js';
import { createMigrationMediaStage, deriveMigratedMedia } from './media-stage.js';
import { assertVerifiedSourceSnapshot, type VerifiedSourceSnapshot } from './preflight.js';
import { sourceTables } from './source-catalog.js';
import { maximumSourceBatch, projectedSourceTables, sourceKey, type SourceTable } from './source-projections.js';
import { completedMigrationTable, reservableSourceTable, walkMigrationStage } from './stage-base.js';
import { openImportRecords, type ImportMap } from './staged-records.js';

const policyVersion = 1;
type Disposition = 'normal' | 'quarantined' | 'excluded' | 'unavailable' | 'blocked';
type SourceCount = Record<Disposition | 'input', string>;
type Case = { table: string; sourceId: string; disposition?: Disposition; reasons: string[] };
type Problem = { type: 'source-count' | 'staged-count' | 'staged-row' | 'storage-media' | 'unsafe-source' | 'scoped-read'; entity: string };
type VerificationMedia = { verifyBlob: PrivateMediaStore['verifyBlob']; scratch: Pick<PrivateMediaStore, 'stage'>; decode: MediaDecoder };
const rowFaults: Partial<Record<MigrationError['fault'], Problem['type']>> = {
  'verification-blocked': 'staged-row', 'target-write': 'staged-row', 'asset-integrity': 'storage-media', 'source-read': 'unsafe-source',
};

function incomplete() {
  return new MigrationError('verification-incomplete', 'The complete inactive import and its protected checkpoint are required for verification.');
}

const caseKey = (table: string, id: string) => `${table}:${id}`;

async function sampleWorkspaceReads(db: Db, generationId: string) {
  const users = db.collection<WorkspaceRow<'users'>>('users');
  const members = db.collection<WorkspaceRow<'boardMembers'>>('boardMembers');
  const managers = db.collection<WorkspaceRow<'projectManagers'>>('projectManagers');
  const boards = db.collection<WorkspaceRow<'boards'>>('boards');
  const cards = db.collection<WorkspaceRow<'cards'>>('cards');
  const cursors = createBoardEventCursors(createSecretKey(randomBytes(32)));
  const result = { boardReads: 0, cardReads: 0, deniedReads: 0 };
  for await (const board of boards.find({ generationId }, { sort: { id: 1 }, limit: 4 })) {
    const direct = await members.find({ generationId, boardId: board.id }, { sort: { id: 1 }, limit: 8 }).toArray();
    for (const { userId } of direct) {
      const actor = await users.findOne({ generationId, id: userId, disabledAt: null });
      if (!actor) continue;
      const access = createWorkspaceAuthorization(db, generationId, actor);
      const reads = createWorkspaceReads(db, access, cursors);
      await reads.boardGet({ id: board.id });
      result.boardReads++;
      const card = await cards.findOne({ generationId, boardId: board.id }, { sort: { id: 1 } });
      if (card) { await reads.cardGet({ id: card.id, boardId: board.id }); result.cardReads++; }
      break;
    }
    const candidates = await users.find({ generationId, role: 'boardUser', disabledAt: null }, { sort: { id: 1 }, limit: 8 }).toArray();
    for (const actor of candidates) {
      if (await members.findOne({ generationId, boardId: board.id, userId: actor.id })
        || await managers.findOne({ generationId, projectId: board.projectId, userId: actor.id })) continue;
      const reads = createWorkspaceReads(db, createWorkspaceAuthorization(db, generationId, actor), cursors);
      try { await reads.boardGet({ id: board.id }); }
      catch (error) {
        if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404) throw error;
        result.deniedReads++;
        break;
      }
      throw new MigrationError('verification-blocked', 'An unaffiliated source account can read a staged board.');
    }
  }
  return result;
}

export async function collectMigrationVerification(db: Db, lease: WriterLease, identity: ImportIdentity, snapshot: VerifiedSourceSnapshot,
  cursors: ReturnType<typeof migrationCursors>, mediaStore: VerificationMedia, signal: AbortSignal) {
  lease.assertHeld();
  assertVerifiedSourceSnapshot(snapshot, true);
  const run = await db.collection<ImportRun>('importRuns').findOne(importRunKey(identity));
  const checkpoint = run?.checkpoint;
  if (!run || run.state !== 'verifying' || !run.verificationStartedAt || run.source.instanceId !== snapshot.capture.sourceInstanceId
    || run.manifestSha256 !== snapshot.manifestSha256 || !isDeepStrictEqual(run.fingerprint, snapshot.fingerprint)
    || !isDeepStrictEqual(identity.fingerprint, snapshot.fingerprint)) throw incomplete();
  if (!checkpoint || checkpoint.pass !== 'media' || checkpoint.table !== completedMigrationTable
    || cursors.open({ runId: run.id, generationId: run.generationId, fingerprint: identity.fingerprint.sha256,
      pass: checkpoint.pass, table: checkpoint.table }, checkpoint.token) !== checkpoint.lastSourceId) throw incomplete();

  try { cursors.assertComplete(run); } catch { throw incomplete(); }

  const accepted = new Map<WorkspaceCollection, number>();
  const projected = new Map<string, number>();
  const verifiedProvenance = new Set<string>();
  const cases = new Map<string, Case>();
  const problems: Problem[] = [];
  const note = (table: string, sourceId: string, reasons: string[], disposition?: Disposition) => {
    const key = caseKey(table, sourceId);
    const previous = cases.get(key);
    cases.set(key, { table, sourceId, reasons: [...new Set([...(previous?.reasons ?? []), ...reasons])].sort(),
      disposition: previous?.disposition === 'blocked' ? 'blocked' : disposition ?? previous?.disposition });
  };
  const { generationId } = identity;
  const records = await openImportRecords(db, lease, identity, run.source.instanceId, {
    accept(collection, fields) {
      accepted.set(collection, (accepted.get(collection) ?? 0) + 1);
      if (collection === 'importQuarantine') note(fields.entity, fields.sourceId, fields.reasons, 'quarantined');
      if (collection === 'importIds' && ['action', 'attachment', 'background_image', 'card', 'project', 'task', 'user_account'].includes(fields.entity)) {
        verifiedProvenance.add(caseKey(fields.entity, fields.sourceId));
      }
    },
  });
  const verifiedParts = new Map<string, number>();
  const verifiedCatalogs = new Set<string>();
  const media = mediaRecords(db, generationId);
  const verifyPart = async (part: BlobIdentity) => {
    const length = verifiedParts.get(part.digest);
    if (length === part.byteLength) return;
    if (length !== undefined) throw new MigrationError('asset-integrity', 'A staged blob has inconsistent lengths.');
    await mediaStore.verifyBlob(part);
    verifiedParts.set(part.digest, part.byteLength);
  };
  const stageMedia = createMigrationMediaStage(records, snapshot, lease, { signal,
    async verifyBlob(key, original, requireImage) {
      if (verifiedCatalogs.has(original.digest) && verifiedParts.get(original.digest) === original.byteLength) return;
      const scratch = await mediaStore.scratch.stage();
      let expected: Awaited<ReturnType<typeof deriveMigratedMedia>>;
      try {
        expected = await deriveMigratedMedia(scratch, snapshot, key, original, requireImage, mediaStore.decode, signal);
      } catch (error) {
        if (error instanceof MediaStorageError) throw incomplete();
        if (error instanceof MediaRejection) throw new MigrationError('asset-integrity', 'The verified source image could not be decoded.');
        throw error;
      } finally { await scratch.dispose(); }
      try {
        const row = await media.catalog(original.digest);
        if (!row || row.lifecycleState !== availableMedia || row.byteLength !== original.byteLength
          || row.id !== nameBasedUuid(run.source.instanceId, `blob:${original.digest}`) || row.mimeType !== expected.mimeType
          || !isDeepStrictEqual(row.variants, expected.variants)) throw new MediaStorageError();
        const variants = catalogVariants(row);
        await verifyPart(original);
        if (variants) { await verifyPart(variants.small); await verifyPart(variants.large); }
        verifiedCatalogs.add(original.digest);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof MediaStorageError) && !(error instanceof BackupError) && !(error instanceof MigrationError)
          && !(error instanceof Error && 'code' in error && ['ENOENT', 'ELOOP', 'EACCES'].includes(String(error.code)))) throw error;
        throw new MigrationError('asset-integrity', 'A staged media object failed verification.');
      }
    },
  });
  let finalPosition: string | null = null;
  await walkMigrationStage(db, identity, snapshot, maximumSourceBatch, records, stageMedia, {
    checkpoint: () => null,
    async batch(position, apply) {
      if (position.pass === 'media' && position.table === completedMigrationTable) finalPosition = position.lastSourceId;
      try { await apply(); }
      catch (error) {
        if (!(error instanceof MigrationError) || error.fault !== 'source-read') throw error;
        problems.push({ type: 'staged-row', entity: position.table });
      }
    },
    async row({ pass, table }, id, apply) {
      signal.throwIfAborted();
      if (pass === 'reserve') projected.set(table, (projected.get(table) ?? 0) + 1);
      try { await apply(); }
      catch (error) {
        if (!(error instanceof MigrationError)) throw error;
        const reason = rowFaults[error.fault];
        if (!reason) throw error;
        note(table, id, [reason], 'blocked');
      }
    },
  });
  if (finalPosition !== checkpoint.lastSourceId) throw incomplete();

  const sourceAssets = { originals: 0, derivatives: 0, missingOriginals: 0, missingDerivatives: 0,
    targetCatalogs: verifiedCatalogs.size, targetBlobParts: verifiedParts.size };
  const originals = new Map<string, { count: number; missing: boolean }>();
  for (const asset of snapshot.assets()) {
    if (asset.kind === 'original') {
      sourceAssets.originals++;
      const isMissing = asset.sha256 === null;
      if (isMissing) sourceAssets.missingOriginals++;
      const sourceId = sourceKey('uploaded_file', asset.key.split('/')[2]);
      const existing = originals.get(sourceId);
      originals.set(sourceId, { count: (existing?.count ?? 0) + 1, missing: isMissing || existing?.missing === true });
    } else {
      sourceAssets.derivatives++;
      if (asset.sha256 === null) sourceAssets.missingDerivatives++;
    }
  }
  const missingOriginals: MissingOriginal[] = [];
  for (const [sourceId, original] of originals) {
    if (original.count > 1) note('uploaded_file', sourceId, ['ambiguous-original'], 'blocked');
    else if (original.missing) missingOriginals.push({ type: 'uploaded_file', sourceId, reason: 'missing-original' });
  }
  const missing = canonicalMissingOriginals(missingOriginals);
  for (const entry of missing) note(entry.type, entry.sourceId, [entry.reason], 'unavailable');
  const collection = db.collection<ImportMap>('importIds');
  const observations = collection.find({ generationId, sourceInstanceId: run.source.instanceId }, { batchSize: maximumSourceBatch });
  for await (const { entity, sourceId, provenance } of observations) {
    signal.throwIfAborted();
    const key = caseKey(entity, sourceId);
    if (!verifiedProvenance.has(key) || cases.get(key)?.disposition === 'blocked') continue;
    if (provenance.media?.kind === 'file') {
      if (provenance.media.state === 'unavailable') note(entity, sourceId, ['original-unavailable'], 'unavailable');
      if (Array.isArray(provenance.media.derivatives) && provenance.media.derivatives.some((asset) => asset?.sha256 === null))
        note(entity, sourceId, ['missing-derivative']);
    }
    if (entity === 'card') {
      const previous = provenance.previousListSourceId;
      if (previous && (await records.get('cards', records.publicId('card', sourceId)))?.previousListId === null)
        note(entity, sourceId, ['stale-previous-list']);
      if (provenance.sourceCommentCount !== provenance.observedCommentCount) note(entity, sourceId, ['comment-count-mismatch']);
    }
    if (provenance.linkedTask?.missingTarget) note(entity, sourceId, ['linked-task-target-unavailable']);
    if (provenance.coverReference?.unresolved) note(entity, sourceId, ['cover-reference-unavailable']);
    if (provenance.backgroundReference?.unresolved) note(entity, sourceId, ['background-reference-unavailable']);
    const discussion = provenance.discussion;
    if (discussion?.type === 'action' && discussion.decoded) {
      const { decoded } = discussion;
      if (decoded.kind === 'moveCard' && (!await records.resolve('list', decoded.snapshot.fromList.id)
        || !await records.resolve('list', decoded.snapshot.toList.id))) note(entity, sourceId, ['historical-list-unavailable']);
      if (decoded.kind === 'createCard' && !await records.resolve('list', decoded.snapshot.list.id))
        note(entity, sourceId, ['historical-list-unavailable']);
    }
  }
  accepted.set('blobs', verifiedCatalogs.size);
  const collectionCounts: Partial<Record<WorkspaceCollection, number>> = {};
  for (const name of workspaceCollections) {
    if (name === 'importRuns') continue;
    const count = await db.collection(name).countDocuments({ generationId });
    if (count !== (accepted.get(name) ?? 0)) problems.push({ type: 'staged-count', entity: name });
    if (count !== 0) collectionCounts[name] = count;
  }
  let scopedReads: Awaited<ReturnType<typeof sampleWorkspaceReads>> | null = null;
  if (!problems.length && ![...cases.values()].some((entry) => entry.disposition === 'blocked')) {
    try { scopedReads = await sampleWorkspaceReads(db, generationId); }
    catch (error) {
      if (!(error instanceof MigrationError) && !(error instanceof WorkspaceAccessError)) throw error;
      problems.push({ type: 'scoped-read', entity: 'boards' });
    }
  }
  const reasons: Record<string, number> = Object.create(null);
  const countByTable = new Map<string, Map<Disposition, bigint>>();
  const details = [...cases.values()].sort((first, second) => Buffer.compare(Buffer.from(caseKey(first.table, first.sourceId)),
    Buffer.from(caseKey(second.table, second.sourceId))));
  for (const entry of details) {
    for (const reason of entry.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (!entry.disposition) continue;
    const table = countByTable.get(entry.table) ?? new Map<Disposition, bigint>();
    table.set(entry.disposition, (table.get(entry.disposition) ?? 0n) + 1n);
    countByTable.set(entry.table, table);
  }
  const tables: Record<string, SourceCount> = {};
  for (const table of sourceTables) {
    const input = BigInt(snapshot.sourceCounts[table]);
    const counts = countByTable.get(table);
    const imported = projected.get(table);
    if (imported !== undefined && BigInt(imported) !== input) problems.push({ type: 'source-count', entity: table });
    const excluded = imported === undefined && !sourceTableIsReservable(table) ? input : 0n;
    if (imported === undefined && excluded === 0n && input !== 0n) problems.push({ type: 'source-count', entity: table });
    const special = [...(counts?.values() ?? [])].reduce((sum, count) => sum + count, 0n);
    if (input < excluded + special) problems.push({ type: 'source-count', entity: table });
    const normal = input >= excluded + special ? input - excluded - special : 0n;
    tables[table] = { input: input.toString(), normal: normal.toString(), quarantined: (counts?.get('quarantined') ?? 0n).toString(),
      excluded: excluded.toString(), unavailable: (counts?.get('unavailable') ?? 0n).toString(), blocked: (counts?.get('blocked') ?? 0n).toString() };
  }
  const blocked = problems.length > 0 || details.some((entry) => entry.disposition === 'blocked');
  const detailSha256 = sha256(Buffer.from(JSON.stringify(details)));
  const summary = {
    formatVersion: policyVersion, runId: run.id, generationId, manifestSha256: snapshot.manifestSha256,
    verificationStartedAt: run.verificationStartedAt.toISOString(),
    fingerprintSha256: snapshot.fingerprint.sha256, outcome: blocked ? 'blocked' as const : 'verified' as const,
    eligibleUnderDefaultPolicy: !blocked && missing.length === 0, tables, assets: sourceAssets, targetRows: collectionCounts, scopedReads,
    reasons, problems, detailSha256, detailCount: details.length,
  };
  return { summary, reportSha256: sha256(Buffer.from(JSON.stringify(summary))), details, missing, checkpoint };
}

function sourceTableIsReservable(table: string) {
  const projected = table as SourceTable;
  return projectedSourceTables.includes(projected) && reservableSourceTable(projected);
}

export type MigrationVerification = Awaited<ReturnType<typeof collectMigrationVerification>>;
