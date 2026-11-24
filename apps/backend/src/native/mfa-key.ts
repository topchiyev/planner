import { createHash, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import type { Db } from 'mongodb';
import type { WriterLease } from '../application/command-gate/writer-lease.js';
import { assertChanged, durable } from '../application/command-journal/records.js';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../storage/schema.js';
import { checkDirectory, fileJson, readProtectedFile, writeProtectedFile } from './mongo-host.js';
import { NativeMongoError } from './mongo-identity.js';

const path = '/etc/planner/mfa-key.json';
const digestPattern = /^[0-9a-f]{64}$/u;

export interface InstallationMfaKey {
  key: KeyObject;
  digest: string;
}

function readKey(installationId: string, group: number): InstallationMfaKey | undefined {
  checkDirectory('/etc/planner', 0, 0, 0o711);
  const contents = readProtectedFile(path, group, 0o640);
  if (contents === undefined) return undefined;
  try {
    const stored = JSON.parse(contents);
    if (stored?.version !== 1 || stored.installationId !== installationId
        || typeof stored.key !== 'string' || !digestPattern.test(stored.key)) throw new Error();
    const raw = Buffer.from(stored.key, 'hex');
    try {
      return { key: createSecretKey(raw), digest: createHash('sha256').update(raw).digest('hex') };
    } finally { raw.fill(0); }
  } catch {
    throw new NativeMongoError('The Planner multifactor key is invalid.');
  }
}

export function readNativeMfaKey(installationId: string, group: number) {
  const key = readKey(installationId, group);
  if (!key) throw new NativeMongoError('The Planner multifactor key is unavailable.');
  return key;
}

export async function assertNativeMfaKey(database: Db, installationId: string, key: InstallationMfaKey) {
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  if (installation.mfaKeyDigest !== key.digest) {
    throw new NativeMongoError('The Planner multifactor key does not match the installation.');
  }
}

// Only an owned, stopped operator can establish the binding. The file is durable before publication.
export async function ensureNativeMfaKey(
  database: Db, installationId: string, group: number, lease: WriterLease,
) {
  lease.assertHeld();
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  const existing = readKey(installationId, group);
  if (installation.mfaKeyDigest !== undefined) {
    if (!existing || existing.digest !== installation.mfaKeyDigest) {
      throw new NativeMongoError('The previously bound Planner multifactor key is unavailable or mismatched.');
    }
    return;
  }
  if (await database.collection('users').findOne({ 'localAuth.factor': { $exists: true } }, { projection: { _id: 1 } })
      || await database.collection('recoveryGrants').findOne({ kind: 'mfa-enrollment', encrypted: { $exists: true } }, { projection: { _id: 1 } })) {
    throw new NativeMongoError('Stored multifactor enrollment has no installation key binding.');
  }
  let key = existing;
  if (!key) {
    const raw = randomBytes(32);
    try { writeProtectedFile(path, fileJson({ version: 1, installationId, key: raw.toString('hex') }), group, 0o640); }
    finally { raw.fill(0); }
    key = readNativeMfaKey(installationId, group);
  }
  lease.assertHeld();
  const bound = await database.collection<InstallationDocument>('installation').updateOne(
    { _id: 'installation', installationId, mfaKeyDigest: { $exists: false } },
    { $set: { mfaKeyDigest: key.digest } }, durable,
  );
  assertChanged(bound.matchedCount);
}

// Only the stopped native restore operator may publish a verified backup encryption key.
export function installRestoredMfaKey(installationId: string, group: number, lease: WriterLease, raw: Buffer, expected: string) {
  lease.assertHeld();
  if (raw.length !== 32 || createHash('sha256').update(raw).digest('hex') !== expected) {
    throw new NativeMongoError('The restored Planner multifactor key does not match the backup.');
  }
  const existing = readKey(installationId, group);
  if (existing ? existing.digest !== expected : false) throw new NativeMongoError('Refusing to replace a different Planner multifactor key.');
  if (!existing) writeProtectedFile(path, fileJson({ version: 1, installationId, key: raw.toString('hex') }), group, 0o640);
  if (readNativeMfaKey(installationId, group).digest !== expected) throw new NativeMongoError('The restored multifactor key could not be verified.');
}
