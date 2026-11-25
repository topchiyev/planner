import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createMediaDecoder } from '../application/media/decoder.js';
import { createPrivateMediaStore } from '../storage/blobs/private-store.js';
import { runMigrationMediaWorker } from './migration-media.js';

try {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!uid || !gid || process.getgroups?.().some((group) => group !== gid) || process.argv.length !== 2) throw new Error();
  process.umask(0o077);
  const control = new Socket({ fd: 4, readable: true, writable: false });
  const decode = createMediaDecoder(fileURLToPath(new URL('../../../../lib/decode-media.py', import.meta.url)));
  await runMigrationMediaWorker(process.stdin, control, process.stdout,
    () => createPrivateMediaStore('/var/lib/planner/staging', '/var/lib/planner/blobs'), decode);
} catch { process.exitCode = 1; }
