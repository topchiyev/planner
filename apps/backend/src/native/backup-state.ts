import { lstatSync, statfsSync } from 'node:fs';
import { nativeInstallationConfig, nativeSetupOptions, type NativeInstallationConfig } from '@planner/contracts/native';
import { generationIdSchema } from '@planner/contracts/storage';
import { BackupError, digestPattern } from '../application/backup/archive.js';
import type { VerifiedBackup } from '../application/backup/restore.js';
import { checkDirectory, fileJson, readProtectedFile, writeProtectedFile } from './mongo-host.js';

const restorePath = '/etc/planner/backup-restore.json';
export const backupRoot = '/var/lib/planner/backups';
export const backupStaging = '/var/lib/planner/staging';
export const backupBlobs = '/var/lib/planner/blobs';
export const backupCreateEndpoint = '/backup/create';

export type DestinationOptions = Omit<NativeInstallationConfig, 'formatVersion' | 'mode' | 'installationId'>;
export type RestoreIntent = {
  version: 1;
  receipt: string;
  fingerprint: string;
  proof: string;
  generationId: string;
  config: NativeInstallationConfig;
};

export function parseRestoreOptions(value: unknown): { archive: string; fingerprint: string; destination: DestinationOptions } {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || !('archive' in value)
      || typeof value.archive !== 'string' || !('fingerprint' in value) || typeof value.fingerprint !== 'string'
      || !digestPattern.test(value.fingerprint) || !('destination' in value) || !value.destination
      || typeof value.destination !== 'object' || Object.keys(value.destination).length !== 3) throw new BackupError('Invalid Planner restore options.');
  const checked = nativeSetupOptions.safeParse({ ...value.destination, mode: 'fresh' });
  if (!checked.success) throw new BackupError('Invalid Planner restore origin or ports.');
  const { publicUrl, appPort, dbPort } = checked.data;
  return { archive: value.archive, fingerprint: value.fingerprint, destination: { publicUrl, appPort, dbPort } };
}

export function readRestoreIntent(receipt: string): RestoreIntent | undefined {
  checkDirectory('/etc/planner', 0, 0, 0o711);
  const text = readProtectedFile(restorePath, 0, 0o600);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    const config = nativeInstallationConfig.parse(value.config);
    if (value.version !== 1 || value.receipt !== receipt || Object.keys(value).length !== 6
        || typeof value.fingerprint !== 'string' || !digestPattern.test(value.fingerprint)
        || typeof value.proof !== 'string' || !digestPattern.test(value.proof)
        || !generationIdSchema.safeParse(value.generationId).success) throw new Error();
    return { ...value, config };
  } catch { throw new BackupError('The Planner restore intent does not belong to this package installation.'); }
}

export function createRestoreIntent(receipt: string, snapshot: VerifiedBackup, destination: DestinationOptions): RestoreIntent {
  const intent: RestoreIntent = { version: 1, receipt, fingerprint: snapshot.fingerprint, proof: snapshot.proof,
    generationId: snapshot.archive.manifest.activeGenerationId, config: { ...snapshot.config, ...destination } };
  if (readRestoreIntent(receipt)) throw new BackupError('The Planner installation already has a restore intent.');
  writeProtectedFile(restorePath, fileJson(intent), 0, 0o600);
  return intent;
}

export function checkRestoreCapacity(snapshot: VerifiedBackup) {
  const database = '/var/lib/planner/mongodb';
  const mongoParts = snapshot.inventory.reduce((sum, { byteLength }) => sum + BigInt(byteLength), 0n);
  const blobParts = snapshot.archive.manifest.blobs.reduce((sum, { byteLength }) => sum + BigInt(byteLength), 0n);
  const reserve = 512n * 1024n * 1024n;
  const available = (path: string) => {
    const stat = statfsSync(path, { bigint: true });
    return stat.bavail * stat.bsize;
  };
  const mongoFree = available(database);
  const blobFree = available(backupBlobs);
  // Reserve for WiredTiger overhead and journals on the volume receiving the MongoDB writes.
  const databaseBudget = mongoParts * 2n + reserve;
  const dbStat = lstatSync(database);
  const blobStat = lstatSync(backupBlobs);
  if (dbStat.dev === blobStat.dev ? mongoFree < databaseBudget + blobParts : mongoFree < databaseBudget || blobFree < blobParts) {
    throw new BackupError('The Planner restore volumes do not have enough free space for the backup.');
  }
}
