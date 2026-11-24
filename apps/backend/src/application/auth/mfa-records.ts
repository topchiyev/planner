import { randomUUID } from 'node:crypto';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import { assertChanged, durable } from '../command-journal/records.js';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { newToken, tokenDigest } from './credentials.js';
import { isEncryptedFactorSecret, type EncryptedFactorSecret } from './mfa-crypto.js';

const proofLifetime = 5 * 60_000;
const attemptLimit = 5;
const trustLifetime = 30 * 24 * 60 * 60_000;
const digestPattern = /^[0-9a-f]{64}$/u;

export interface FactorState {
  id: string;
  encrypted: EncryptedFactorSecret;
  greatestCounter: number;
  recoveryDigests: string[];
}

export function isFactorState(value: unknown): value is FactorState {
  if (!value || typeof value !== 'object') return false;
  const factor = value as FactorState;
  return publicIdSchema.safeParse(factor.id).success && isEncryptedFactorSecret(factor.encrypted)
    && Number.isSafeInteger(factor.greatestCounter) && factor.greatestCounter >= 0
    && Array.isArray(factor.recoveryDigests) && factor.recoveryDigests.length <= 10
    && new Set(factor.recoveryDigests).size === factor.recoveryDigests.length
    && factor.recoveryDigests.every((digest) => typeof digest === 'string' && digestPattern.test(digest));
}

interface ActorScope {
  installationId: string;
  generationId: string;
  userId: string;
  credentialsVersion: number;
}

type ProofPurpose =
  | { kind: 'mfa-challenge'; factorId: string }
  | { kind: 'mfa-enrollment'; source: 'password'; }
  | { kind: 'mfa-enrollment'; source: 'session'; sessionDigest: string }
  | { kind: 'mfa-enrollment'; source: 'staged'; recoveryId: string };

export type MfaProof = ActorScope & ProofPurpose & {
  _id: string;
  id: string;
  tokenDigest: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  encrypted?: EncryptedFactorSecret;
};

const proofs = (database: Db) => database.collection<MfaProof>('recoveryGrants');

export async function issueMfaProof(database: Db, scope: ActorScope, purpose: ProofPurpose, time: Date) {
  const token = newToken();
  const id = randomUUID();
  await proofs(database).insertOne({
    ...scope, ...purpose, _id: workspaceKey(scope.generationId, id), id, tokenDigest: tokenDigest(token),
    issuedAt: time, expiresAt: new Date(time.getTime() + proofLifetime), consumedAt: null, attempts: 0,
  }, durable);
  return token;
}

export async function findMfaProof(
  database: Db, installationId: string, generationId: string, kind: MfaProof['kind'], token: string, time: Date,
) {
  const proof = await proofs(database).findOne({
    installationId, generationId, kind, tokenDigest: tokenDigest(token), consumedAt: { $type: 'null' },
    issuedAt: { $lte: time }, expiresAt: { $gt: time }, attempts: { $lt: attemptLimit },
  });
  if (!proof) return null;
  if (!publicIdSchema.safeParse(proof.id).success || proof._id !== workspaceKey(generationId, proof.id)
      || !publicIdSchema.safeParse(proof.userId).success || !Number.isSafeInteger(proof.credentialsVersion)
      || proof.credentialsVersion < 1 || !Number.isSafeInteger(proof.attempts) || proof.attempts < 0
      || !isStoredDate(proof.issuedAt) || !isStoredDate(proof.expiresAt)
      || proof.expiresAt.getTime() !== proof.issuedAt.getTime() + proofLifetime) return null;
  if (proof.kind === 'mfa-challenge') return publicIdSchema.safeParse(proof.factorId).success ? proof : null;
  if (proof.encrypted !== undefined && !isEncryptedFactorSecret(proof.encrypted)) return null;
  if (proof.source === 'session') return digestPattern.test(proof.sessionDigest) ? proof : null;
  if (proof.source === 'staged') return publicIdSchema.safeParse(proof.recoveryId).success ? proof : null;
  return proof.source === 'password' ? proof : null;
}

export async function hasConsumedStagedProof(database: Db, scope: ActorScope, recoveryId: string, factorId: string, time: Date) {
  const proof = await proofs(database).findOne({
    ...scope, _id: workspaceKey(scope.generationId, factorId), id: factorId, kind: 'mfa-enrollment', source: 'staged',
    recoveryId, consumedAt: time, issuedAt: { $lte: time }, expiresAt: { $gt: time }, encrypted: { $exists: false },
  });
  return proof !== null && isStoredDate(proof.issuedAt) && isStoredDate(proof.expiresAt)
    && proof.expiresAt.getTime() === proof.issuedAt.getTime() + proofLifetime
    && Number.isSafeInteger(proof.attempts) && proof.attempts >= 0 && proof.attempts < attemptLimit
    && typeof proof.tokenDigest === 'string' && digestPattern.test(proof.tokenDigest);
}

function proofMatch(proof: MfaProof, time: Date) {
  return {
    _id: proof._id, installationId: proof.installationId, generationId: proof.generationId, userId: proof.userId,
    credentialsVersion: proof.credentialsVersion, kind: proof.kind, tokenDigest: proof.tokenDigest,
    issuedAt: { $lte: time }, expiresAt: { $gt: time }, consumedAt: { $type: 'null' as const }, attempts: proof.attempts,
    ...(proof.kind === 'mfa-challenge' ? { factorId: proof.factorId } : {
      source: proof.source,
      ...(proof.source === 'session' && { sessionDigest: proof.sessionDigest }),
      ...(proof.source === 'staged' && { recoveryId: proof.recoveryId }),
      ...(proof.encrypted && { encrypted: proof.encrypted }),
    }),
  };
}

export async function recordFailedFactor(database: Db, proof: MfaProof, time: Date) {
  const update = await proofs(database).updateOne(proofMatch(proof, time), { $inc: { attempts: 1 } }, durable);
  assertChanged(update.matchedCount);
}

export async function consumeMfaProof(database: Db, proof: MfaProof, time: Date) {
  const update = await proofs(database).updateOne(proofMatch(proof, time),
    { $set: { consumedAt: time }, $unset: { encrypted: '' } }, durable);
  assertChanged(update.matchedCount);
}

export async function setEnrollmentSecret(database: Db, proof: MfaProof, time: Date, encrypted: EncryptedFactorSecret) {
  const update = await proofs(database).updateOne({ ...proofMatch(proof, time), encrypted: { $exists: false } },
    { $set: { encrypted } }, durable);
  assertChanged(update.matchedCount);
}

interface TrustedDeviceRecord extends ActorScope {
  _id: string;
  id: string;
  tokenDigest: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

function deviceScope(scope: ActorScope, time: Date) {
  return {
    installationId: scope.installationId, generationId: scope.generationId, userId: scope.userId,
    credentialsVersion: scope.credentialsVersion, revokedAt: { $type: 'null' as const },
    createdAt: { $lte: time }, expiresAt: { $gt: time },
  };
}

function validDevice(device: TrustedDeviceRecord, time: Date) {
  return publicIdSchema.safeParse(device.id).success && device._id === workspaceKey(device.generationId, device.id)
    && isStoredDate(device.createdAt) && isStoredDate(device.lastUsedAt) && isStoredDate(device.expiresAt)
    && device.expiresAt.getTime() === device.createdAt.getTime() + trustLifetime
    && device.createdAt <= device.lastUsedAt && device.lastUsedAt <= time
    && typeof device.tokenDigest === 'string' && digestPattern.test(device.tokenDigest);
}

const devices = (database: Db) => database.collection<TrustedDeviceRecord>('trustedDevices');

export async function createTrustedDevice(database: Db, scope: ActorScope, time: Date) {
  const id = randomUUID();
  const token = newToken();
  await devices(database).insertOne({
    ...scope, _id: workspaceKey(scope.generationId, id), id, tokenDigest: tokenDigest(token),
    createdAt: time, lastUsedAt: time, expiresAt: new Date(time.getTime() + trustLifetime), revokedAt: null,
  }, durable);
  return token;
}

export async function useTrustedDevice(database: Db, scope: ActorScope, time: Date, token: string) {
  const match = { ...deviceScope(scope, time), tokenDigest: tokenDigest(token) };
  const existing = await devices(database).findOne(match);
  if (!existing || !validDevice(existing, time)) return false;
  const update = await devices(database).updateOne({ ...match, _id: existing._id }, { $max: { lastUsedAt: time } }, durable);
  assertChanged(update.matchedCount);
  return true;
}

export async function listTrustedDevices(database: Db, scope: ActorScope, time: Date, token?: string) {
  const current = token === undefined ? undefined : tokenDigest(token);
  const items = await devices(database).find(deviceScope(scope, time)).sort({ createdAt: -1 }).toArray();
  return items.filter((item) => validDevice(item, time)).map((item) => ({
    id: item.id, createdAt: item.createdAt.toISOString(), expiresAt: item.expiresAt.toISOString(),
    lastUsedAt: item.lastUsedAt.toISOString(), current: item.tokenDigest === current,
  }));
}

export async function revokeTrustedDevice(database: Db, scope: ActorScope, time: Date, id: string, token?: string) {
  const device = await devices(database).findOneAndUpdate(
    { ...deviceScope(scope, time), _id: workspaceKey(scope.generationId, id), id }, { $set: { revokedAt: time } }, durable,
  );
  return device ? { current: token !== undefined && device.tokenDigest === tokenDigest(token) } : null;
}
