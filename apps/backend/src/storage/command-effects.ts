import { isDeepStrictEqual } from 'node:util';
import { MongoServerError, type Db, type Filter } from 'mongodb';
import { CommandRecoveryError } from '../application/command-journal/operation.js';
import { durable, type Effect } from '../application/command-journal/records.js';
import { workspaceKey } from './identity.js';
import { encodeWorkspaceFields, workspaceInsertFields } from './scoped.js';

interface Target {
  _id: string;
  id: string;
  generationId: string;
  revision?: number;
  commandEffectId?: string;
  [key: string]: unknown;
}

export async function applyCommandEffect(
  database: Db, generationId: string, effect: Effect, deleteReserved: boolean, reserveDelete: () => Promise<void>,
) {
  const collection = database.collection<Target>(effect.collection);
  const target = { _id: workspaceKey(generationId, effect.id), id: effect.id, generationId };
  const proof = { commandEffectId: effect.effectId };
  const read = () => collection.findOne(target, { promoteLongs: false });
  const readProof = async (expected: Record<string, unknown>, exact = false) => {
    const stored = await read();
    if (!stored || !(exact ? isDeepStrictEqual(stored, expected)
      : Object.entries(expected).every(([key, value]) => isDeepStrictEqual(stored[key], value)))) {
      throw new CommandRecoveryError('A command effect does not match the stored target or its proof.');
    }
  };
  if (effect.kind === 'insert') {
    const document = { ...workspaceInsertFields(effect.collection, effect.fields, effect.revision), ...target, ...proof };
    try { await collection.insertOne(document, durable); }
    catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      await readProof(document, true);
    }
    return;
  }
  const version: Filter<Target> = { ...target,
    revision: effect.revision === null ? { $exists: false } : effect.revision };
  if (effect.kind === 'update') {
    const written = { ...encodeWorkspaceFields(effect.fields), ...proof, revision: (effect.revision ?? 0) + 1 };
    const result = await collection.updateOne(version, { $set: written }, durable);
    if (result.matchedCount !== 1) await readProof(written);
    return;
  }
  if (!deleteReserved) {
    const claimed = await collection.updateOne(version, { $set: proof }, durable);
    if (claimed.matchedCount !== 1) throw new CommandRecoveryError('A command deletion target is missing or has changed.');
    // The durable reservation and the target's atomic claim distinguish a completed delete from a missing target.
    await reserveDelete();
  }
  const deleted = await collection.deleteOne({ ...version, ...proof }, durable);
  if (deleted.deletedCount !== 1 && await read()) {
    throw new CommandRecoveryError('A command deletion target does not match its stored proof.');
  }
}
