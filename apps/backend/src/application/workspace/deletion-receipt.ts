import type { Db } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { canonicalJournalData, commandUuid, journalDigest, type JournalFields } from '../command-journal/operation.js';
import { checkCommand, commands, readJournalResult } from '../command-journal/records.js';
import type { WorkspaceAuthorization } from './authorization.js';

// Call only after verifying the current active actor. The caller validates and scopes the returned receipt.
export async function readTerminalDeletionReceipt(database: Db, scope: WorkspaceAuthorization, operationId: string,
  idempotencyKey: string, input: JournalFields & { id: string }) {
  const generationId = scope.generationId;
  const actorId = scope.actor.id;
  const id = commandUuid(generationId, ['command', actorId, operationId, idempotencyKey]);
  const receipt = await commands(database).findOne({ _id: workspaceKey(generationId, id), id, generationId, actorId,
    operationId, idempotencyKey, status: 'committed', requestHash: journalDigest(canonicalJournalData(input)) }, { promoteLongs: false });
  if (!receipt) return null;
  checkCommand(receipt);
  return readJournalResult(receipt);
}

export async function hasTerminalDeletionReceipt(database: Db, scope: WorkspaceAuthorization, operationId: string,
  idempotencyKey: string, input: JournalFields & { id: string }) {
  const result = await readTerminalDeletionReceipt(database, scope, operationId, idempotencyKey, input);
  return canonicalJournalData(result) === canonicalJournalData({ data: { id: input.id } });
}
