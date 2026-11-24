import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { acquireWriterDirectory, WriterOwnershipError } from '../../apps/backend/dist/application/command-gate/writer-lease.js';

const [role, directory, effects] = process.argv.slice(2);
const owner = { uid: process.getuid(), gid: process.getgid() };
let lease;
try {
  lease = acquireWriterDirectory(directory, owner, owner);
} catch (error) {
  if (!(error instanceof WriterOwnershipError) || !error.message.includes('already owns')) throw error;
  process.send({ status: 'refused' });
  process.disconnect();
  process.exitCode = 75;
}
if (lease) {
  appendFileSync(effects, `${role}\n`);
  if (role === 'app') {
    const worker = spawn('/usr/bin/sleep', ['30'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {
      worker.kill();
      lease.release();
      process.disconnect();
    });
    process.send({ status: 'acquired', workerPid: worker.pid });
  } else {
    lease.release();
    process.send({ status: 'acquired' });
    process.disconnect();
  }
}
