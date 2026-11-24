import { ensureNativeMongo } from './mongo-host.js';
import { NativeMongoError } from './mongo-identity.js';

try {
  const port = process.argv[2];
  if (process.argv.length !== 3 || !/^[1-9]\d{0,4}$/u.test(port ?? '')) {
    throw new NativeMongoError('Pass exactly one private MongoDB port to the native bootstrap entry point.');
  }
  console.log(JSON.stringify(await ensureNativeMongo(Number(port))));
} catch (error) {
  console.error(error instanceof NativeMongoError ? error.message : 'Planner database initialization could not be verified.');
  process.exitCode = 1;
}
