import { CommandGate } from '../application/command-gate/gate.js';
import { acquireWriterDirectory } from '../application/command-gate/writer-lease.js';
import { adminRuntimeDirectory } from './admin-socket.js';
import { packageAccount } from './mongo-host.js';

// The root-owned /run parent protects this directory inode from replacement by Planner.
export function acquireNativeWriter() {
  return acquireWriterDirectory(adminRuntimeDirectory, {
    uid: packageAccount('-u', 'planner'), gid: packageAccount('-g', 'planner'),
  }, { uid: 0, gid: 0 });
}

export function createNativeCommandGate() {
  return new CommandGate(acquireNativeWriter());
}
