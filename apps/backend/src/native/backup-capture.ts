import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { CommandGate } from '../application/command-gate/gate.js';
import { BackupError } from '../application/backup/archive.js';
import { createBackup } from '../application/backup/capture.js';
import type { PrivateMediaStore } from '../storage/blobs/private-store.js';
import { backupRoot } from './backup-state.js';
import type { InstallationMfaKey } from './mfa-key.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export function createNativeBackup(config: NativeInstallationConfig, gate: CommandGate, key: InstallationMfaKey, store: PrivateMediaStore) {
  let capturing = false;
  return async () => {
    if (capturing) throw new BackupError('A Planner backup capture is already in progress.');
    capturing = true;
    try {
      const client = await connectConfiguredNativeMongo(config);
      const contents = key.key.export();
      try {
        return await createBackup(gate, client.db(databaseName), config, contents, store, backupRoot,
          { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 });
      } finally { contents.fill(0); await client.close(); }
    } finally { capturing = false; }
  };
}
