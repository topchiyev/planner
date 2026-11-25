import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquireWriterDirectory } from '../../apps/backend/dist/application/command-gate/writer-lease.js';
import { createMediaDecoder } from '../../apps/backend/dist/application/media/decoder.js';
import { nativeMigrationMediaPublisher, runMigrationMediaWorker } from '../../apps/backend/dist/native/migration-media.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';

const thisFile = fileURLToPath(import.meta.url);
const rootOwner = { uid: 0, gid: 0 };
const [mode, base, executable, decoderPath] = process.argv.slice(2);
const service = { uid: 65534, gid: 65534 };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function runWorker() {
  assert.equal(process.getuid(), service.uid);
  assert.equal(process.getgid(), service.gid);
  assert.ok(process.getgroups().every((id) => id === service.gid));
  assert.match(await readFile('/proc/self/status', 'utf8'), /^NoNewPrivs:\s+1$/m);
  await assert.rejects(readFile(join(base, 'capture', 'original.png')), { code: 'EACCES' });
  process.umask(0o077);
  const control = new Socket({ fd: 4, readable: true, writable: false });
  const run = async () => {
    const store = await createPrivateMediaStore(join(base, 'staging'), join(base, 'blobs'));
    if (mode === 'worker') return store;
    return { ...store, async stage() {
      const stage = await store.stage();
      return { ...stage, async publish(items) {
        const unpin = await stage.publish(items);
        await writeFile(join(base, 'staging', 'linked'), '1');
        await delay(2500);
        return unpin;
      } };
    } };
  };
  const decode = createMediaDecoder(decoderPath, executable);
  await runMigrationMediaWorker(process.stdin, control, process.stdout, run, decode);
}

async function rootPublication(work, waitInPublish = false, fail = false) {
  const writer = acquireWriterDirectory(join(work, 'writer'), rootOwner, rootOwner);
  try {
    const publish = nativeMigrationMediaPublisher(service, writer, thisFile,
      [waitInPublish ? 'worker-hold' : 'worker', work, executable, decoderPath]);
    const bytes = await readFile(join(work, 'capture', 'original.png'));
    const expected = { digest: sha256(bytes), byteLength: bytes.length };
    const signal = new AbortController().signal;
    const prepared = await publish(expected, async (consume, reading) => {
      async function* bytesFromCapture() { yield bytes.subarray(0, 8); yield bytes.subarray(8); }
      await consume(bytesFromCapture(), reading);
    }, signal);
    try {
      assert.equal(prepared.media.digest, expected.digest);
      assert.equal(prepared.media.mimeType, 'image/png');
      assert.ok(prepared.media.variants?.small.byteLength);
      if (!fail) await prepared.publish();
    } finally { await prepared.close(); }
    return expected;
  } finally { writer.release(); }
}

async function qualify() {
  assert.equal(process.getuid(), 0);
  const work = await mkdtemp('/var/tmp/planner-migration-worker-');
  await chmod(work, 0o711);
  const dirs = ['staging', 'blobs', 'capture', 'writer'];
  let operator;
  try {
    for (const dir of dirs) await mkdir(join(work, dir), { mode: dir === 'writer' ? 0o750 : 0o700 });
    for (const dir of ['staging', 'blobs']) await chown(join(work, dir), service.uid, service.gid);
    const original = join(work, 'capture', 'original.png');
    await writeFile(original, await readFile(base), { mode: 0o600 });
    const before = await readFile(original);
    await rootPublication(work, false, true);
    assert.deepEqual(await readdir(join(work, 'staging')), []);
    assert.deepEqual(await readdir(join(work, 'blobs')), []);
    operator = fork(thisFile, ['operator', work, executable, decoderPath], { execArgv: [], stdio: 'ignore' });
    const exited = new Promise((resolve) => operator.once('exit', (_code, signal) => resolve(signal)));
    const marker = join(work, 'staging', 'linked');
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await stat(marker).catch(() => null)) break;
      await delay(25);
    }
    await stat(marker);
    operator.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');
    assert.throws(() => acquireWriterDirectory(join(work, 'writer'), rootOwner, rootOwner), /Another Planner writer/u);
    let next;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { next = acquireWriterDirectory(join(work, 'writer'), rootOwner, rootOwner); break; }
      catch { await delay(40); }
    }
    assert.ok(next, 'The surviving media helper released its inherited writer lease after cleanup.');
    next.release();
    await rm(marker);
    const expected = await rootPublication(work);
    assert.deepEqual(await readdir(join(work, 'staging')), []);
    const blob = join(work, 'blobs', expected.digest);
    assert.deepEqual(await readFile(blob), before);
    const owner = await stat(blob);
    assert.deepEqual([owner.uid, owner.gid, owner.mode & 0o777], [service.uid, service.gid, 0o400]);
    assert.deepEqual(await readFile(original), before);
    console.log('Protected source permissions, Planner-owned Pillow publication and writer lease recovery verified.');
  } finally {
    if (operator?.exitCode === null && operator.signalCode === null) operator.kill('SIGKILL');
    await rm(work, { recursive: true, force: true });
  }
}

if (mode === 'worker' || mode === 'worker-hold') {
  await runWorker().catch(() => { process.exitCode = 1; });
} else if (mode === 'operator') await rootPublication(base, true);
else if (mode === 'verify') await qualify();
else throw new Error('Choose a synthetic migration media qualification mode.');
