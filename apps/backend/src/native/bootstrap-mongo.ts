import { ensureNativeMongo } from './mongo-host.js';
import { NativeMongoError } from './mongo-identity.js';
import { WriterOwnershipError } from '../application/command-gate/writer-lease.js';
import { acquireNativeWriter } from './writer.js';

try {
  const port = process.argv[2];
  if (process.argv.length !== 3 || !/^[1-9]\d{0,4}$/u.test(port ?? '')) {
    throw new NativeMongoError('Pass exactly one private MongoDB port to the native bootstrap entry point.');
  }
  const writer = acquireNativeWriter();
  try { console.log(JSON.stringify(await ensureNativeMongo(Number(port)))); }
  finally { writer.release(); }
} catch (error) {
  console.error(error instanceof NativeMongoError || error instanceof WriterOwnershipError
    ? error.message : 'Planner database initialization could not be verified.');
  process.exitCode = 1;
}
