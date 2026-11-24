import { BSON, type Db, Long } from 'mongodb';
import { generationIdSchema, publicIdSchema, revisionSchema } from '@planner/contracts/storage';
import { workspaceCollections, type WorkspaceCollection } from '../../storage/catalog.js';
import { decodeRank, isStoredDate, workspaceKey } from '../../storage/identity.js';
import { encodeWorkspaceFields, workspaceInsertFields } from '../../storage/scoped.js';
import {
  canonicalJournalData, CommandRecoveryError, commandUuid, isCommandName, journalDigest, type PlannedEffect,
} from './operation.js';

export const durable = { writeConcern: { w: 1, j: true } } as const;
export const maximumBatchEffects = 256;
export const maximumBatchBytes = 2 * 1024 * 1024;
const digestPattern = /^[0-9a-f]{64}$/u;
const internalCollections = new Set<WorkspaceCollection>([
  'commands', 'commandEffectBatches', 'events', 'auditEntries',
  'sessions', 'recoveryGrants', 'trustedDevices', 'oauthArtifacts', 'oauthConnections',
  'importRuns', 'importIds', 'importQuarantine',
]);
const effectCollections = new Set<WorkspaceCollection>(workspaceCollections.filter((name) => !internalCollections.has(name)));

export type Effect = PlannedEffect & { effectId: string };
export interface BatchSummary { digest: string; count: number }
export interface CommandRecord {
  _id: string;
  id: string;
  generationId: string;
  actorId: string;
  operationId: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: Date;
  recoverySequence?: Long;
  status: 'building' | 'prepared' | 'committed';
  applied?: number;
  pendingDelete?: string;
  manifest?: BatchSummary[];
  result?: string;
  resultHash?: string;
  eventCount?: number;
  delivered?: number;
  outboxPending?: boolean;
  committedAt?: Date;
}

interface BatchRecord {
  _id: string;
  id: string;
  generationId: string;
  commandId: string;
  batch: number;
  payload: string;
}

export function commands(database: Db) { return database.collection<CommandRecord>('commands'); }
export function batches(database: Db) { return database.collection<BatchRecord>('commandEffectBatches'); }

export function assertChanged(count: number) {
  if (count !== 1) throw new CommandRecoveryError('A journal record changed unexpectedly.');
}

export function checkCommand(command: CommandRecord) {
  const { id, generationId, actorId, operationId, idempotencyKey, status } = command;
  if (!generationIdSchema.safeParse(generationId).success || !publicIdSchema.safeParse(actorId).success
      || !publicIdSchema.safeParse(idempotencyKey).success || !isCommandName(operationId)
      || id !== commandUuid(generationId, ['command', actorId, operationId, idempotencyKey])
      || command._id !== workspaceKey(generationId, id) || typeof command.requestHash !== 'string'
      || !digestPattern.test(command.requestHash) || !isStoredDate(command.createdAt)) {
    throw new CommandRecoveryError('A command journal identity is invalid.');
  }
  if (status === 'building') {
    if ([command.applied, command.pendingDelete, command.manifest, command.result, command.resultHash, command.committedAt,
      command.eventCount, command.delivered, command.outboxPending, command.recoverySequence]
      .some((value) => value !== undefined)) throw new CommandRecoveryError('A building command has active effects.');
    return;
  }
  if (!['prepared', 'committed'].includes(status) || !Long.isLong(command.recoverySequence)
      || decodeRank(command.recoverySequence) <= 0n || !Array.isArray(command.manifest)
      || !command.manifest.length || typeof command.result !== 'string' || typeof command.resultHash !== 'string'
      || journalDigest(command.result) !== command.resultHash || !Number.isSafeInteger(command.applied) || command.applied! < 0
      || (status === 'prepared' ? command.committedAt !== undefined : !isStoredDate(command.committedAt))) {
    throw new CommandRecoveryError('A prepared command journal record is invalid.');
  }
  const total = command.manifest.reduce((sum, item) => {
    if (!item || typeof item.digest !== 'string' || !digestPattern.test(item.digest)
        || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > maximumBatchEffects) {
      throw new CommandRecoveryError('A command batch manifest is invalid.');
    }
    return sum + item.count;
  }, 0);
  if (command.applied! > total || (status === 'committed' && (command.applied !== total || command.pendingDelete !== undefined))) {
    throw new CommandRecoveryError('The command journal cursor is invalid.');
  }
  checkOutboxCursor(command);
  if (command.eventCount! >= total || (status === 'prepared' && command.delivered !== 0)) {
    throw new CommandRecoveryError('The command outbox cursor is invalid.');
  }
  readJournalResult(command);
}

export function checkOutboxCursor(command: Pick<CommandRecord, 'eventCount' | 'delivered' | 'outboxPending'>) {
  if (!Number.isSafeInteger(command.eventCount) || command.eventCount! < 0
      || !Number.isSafeInteger(command.delivered) || command.delivered! < 0 || command.delivered! > command.eventCount!
      || command.outboxPending !== (command.delivered! < command.eventCount!)) {
    throw new CommandRecoveryError('The command outbox cursor is invalid.');
  }
}

export function readJournalResult(command: CommandRecord) {
  const result = JSON.parse(command.result!);
  if (canonicalJournalData(result) !== command.result) throw new CommandRecoveryError('The stored command result is invalid.');
  return result;
}

export function validateEffect(effect: PlannedEffect, internal: boolean) {
  if (!effect || !publicIdSchema.safeParse(effect.id).success
      || (!effectCollections.has(effect.collection) && !(internal && effect.kind === 'insert'
        && (effect.collection === 'auditEntries' || effect.collection === 'events')))) {
    throw new CommandRecoveryError('A command effect targets an invalid collection or record.');
  }
  if (effect.kind === 'insert') {
    workspaceInsertFields(effect.collection, effect.fields);
    return;
  }
  if (effect.kind === 'update') encodeWorkspaceFields(effect.fields);
  if (effect.kind === 'delete' && effect.revision === null) return;
  if ((effect.kind !== 'update' && effect.kind !== 'delete') || !revisionSchema.safeParse(effect.revision).success
      || (effect.kind === 'update' && !revisionSchema.safeParse(effect.revision + 1).success)) {
    throw new CommandRecoveryError('A command effect has an invalid revision or kind.');
  }
}

function batchIdentity(command: CommandRecord, batch: number) {
  const id = commandUuid(command.id, ['batch', String(batch)]);
  return { _id: workspaceKey(command.generationId, id), id, generationId: command.generationId, commandId: command.id, batch };
}

export function packBatches(command: CommandRecord, effects: PlannedEffect[]) {
  const records: BatchRecord[] = [];
  const manifest: BatchSummary[] = [];
  let encoded: string[] = [];
  let size = 0;
  const flush = () => {
    const payload = `[${encoded.join(',')}]`;
    const record = { ...batchIdentity(command, records.length), payload };
    if (BSON.calculateObjectSize(record) > maximumBatchBytes) throw new CommandRecoveryError('A command effect exceeds the batch size limit.');
    records.push(record);
    manifest.push({ digest: journalDigest(payload), count: encoded.length });
    encoded = [];
    size = 0;
  };
  for (const [index, effect] of effects.entries()) {
    const entry = canonicalJournalData({ ...effect, effectId: effectId(command, index) });
    const bytes = Buffer.byteLength(entry);
    const overhead = BSON.calculateObjectSize({ ...batchIdentity(command, records.length), payload: '[]' });
    if (encoded.length && (encoded.length === maximumBatchEffects || overhead + size + encoded.length + bytes > maximumBatchBytes)) flush();
    encoded.push(entry);
    size += bytes;
  }
  if (encoded.length) flush();
  return { records, manifest };
}

export function effectId(command: CommandRecord, index: number) {
  return commandUuid(command.id, ['effect', String(index)]);
}

export async function* readBatches(database: Db, command: CommandRecord) {
  let batch = 0;
  let index = 0;
  const records = batches(database).find({ generationId: command.generationId, commandId: command.id }).sort({ batch: 1 });
  for await (const record of records) {
    const expected = command.manifest?.[batch];
    const identity = batchIdentity(command, batch);
    if (!expected || record._id !== identity._id || record.id !== identity.id || record.batch !== batch
        || typeof record.payload !== 'string' || BSON.calculateObjectSize(record) > maximumBatchBytes
        || journalDigest(record.payload) !== expected.digest) throw new CommandRecoveryError('A stored command batch does not match its manifest.');
    const effects = JSON.parse(record.payload) as Effect[];
    if (!Array.isArray(effects) || effects.length !== expected.count || canonicalJournalData(effects) !== record.payload) {
      throw new CommandRecoveryError('A stored command batch contents are invalid.');
    }
    for (const effect of effects) {
      validateEffect(effect, true);
      if (effect.effectId !== effectId(command, index++)) throw new CommandRecoveryError('A command effect identity is invalid.');
    }
    batch += 1;
    yield effects;
  }
  if (batch !== command.manifest?.length) throw new CommandRecoveryError('A command batch is missing.');
}
