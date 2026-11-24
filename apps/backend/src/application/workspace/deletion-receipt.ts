import type { Db } from 'mongodb';
import { workspaceKey } from '../../storage/identity.js';
import { canonicalJournalData, commandUuid, journalDigest, type JournalFields } from '../command-journal/operation.js';
import { checkCommand, commands, readJournalResult } from '../command-journal/records.js';
import type { WorkspaceAuthorization } from './authorization.js';

// A command can use this only after verifying its current active actor. The terminal result carries no resource details.
export async function hasTerminalDeletionReceipt(database: Db, scope: WorkspaceAuthorization, operationId: string,
  idempotencyKey: string, input: JournalFields & { id: string }) {
  const generationId = scope.generationId;
  const actorId = scope.actor.id;
  const id = commandUuid(generationId, ['command', actorId, operationId, idempotencyKey]);
  const receipt = await commands(database).findOne({ _id: workspaceKey(generationId, id), id, generationId, actorId,
    operationId, idempotencyKey, status: 'committed', requestHash: journalDigest(canonicalJournalData(input)) }, { promoteLongs: false });
  if (!receipt) return false;
  checkCommand(receipt);
  return canonicalJournalData(readJournalResult(receipt)) === canonicalJournalData({ data: { id: input.id } });
}
