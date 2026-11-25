import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMediaDecoder } from '../../apps/backend/dist/application/media/decoder.js';
import { localMigrationMediaPublisher } from '../../apps/backend/dist/application/migration/media-publication.js';
import { createPrivateMediaStore } from '../../apps/backend/dist/storage/blobs/private-store.js';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const python = process.env.PLANNER_TEST_MEDIA_PYTHON ?? '/usr/bin/python3';
const decoderAvailable = process.env.PLANNER_TEST_MEDIA_PYTHON
  || spawnSync(python, ['-I', '-B', '-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
const rejected = (error) => error?.kind === 'image';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function secondaryEntry(bytes) {
  const mp = bytes.indexOf(Buffer.from('MPF\0')) + 4;
  assert.ok(mp > 4);
  assert.equal(bytes.subarray(mp, mp + 2).toString(), 'II');
  const directory = mp + bytes.readUInt32LE(mp + 4);
  const count = bytes.readUInt16LE(directory);
  for (let index = 0; index < count; index++) {
    const tag = directory + 2 + index * 12;
    if (bytes.readUInt16LE(tag) === 0xb002) return { mp, entry: mp + bytes.readUInt32LE(tag + 8) + 16 };
  }
  throw new Error('Synthetic MP entries are missing');
}

test('migration decodes bounded MPO constituents while interactive uploads retain the JPEG policy',
  { timeout: 20_000, skip: !decoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'planner-migration-mpo-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, 'fixture.mpo');
    const fixture = spawnSync(python, ['-I', '-B', path('../fixtures/media/migration-mpo.py'), filename], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const source = await readFile(filename);
    const staging = join(root, 'staging');
    const blobs = join(root, 'blobs');
    await mkdir(staging, { mode: 0o700 });
    await mkdir(blobs, { mode: 0o700 });
    const store = await createPrivateMediaStore(staging, blobs);
    t.after(() => store.close());
    const decode = createMediaDecoder(path('../../ops/package/decode-media.py'), python);
    const prepare = localMigrationMediaPublisher(store, decode);
    const signal = new AbortController().signal;
    const stage = await store.stage();
    try {
      await stage.receive(Readable.from([source]), source.length, signal);
      await assert.rejects(decode(stage, 'JPEG', signal), rejected);
    } finally { await stage.dispose(); }
    const stageMigration = (bytes) => prepare({ digest: sha256(bytes), byteLength: bytes.length },
      (consume, reading) => consume(Readable.from([bytes]), reading), signal);
    const migrated = await stageMigration(source);
    try {
      assert.deepEqual([migrated.media.digest, migrated.media.byteLength, migrated.media.mimeType], [sha256(source), source.length, 'image/jpeg']);
      await migrated.publish();
      assert.deepEqual(await readFile(join(blobs, migrated.media.digest)), source);
      for (const [variant, width] of [['small', 320], ['large', 500]]) {
        const identity = migrated.media.variants[variant];
        await store.verifyBlob(identity);
        const png = await readFile(join(blobs, identity.digest));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), width);
      }
    } finally { await migrated.close(); }

    const { mp, entry } = secondaryEntry(source);
    const outside = Buffer.from(source);
    outside.writeUInt32LE(source.length, entry + 8);
    await assert.rejects(stageMigration(outside), rejected);
    const invalidFrame = Buffer.from(source);
    const start = mp + source.readUInt32LE(entry + 8);
    const end = start + source.readUInt32LE(entry + 4);
    invalidFrame.fill(0, start + 3, end - 2);
    await assert.rejects(stageMigration(invalidFrame), rejected);
    assert.deepEqual(await readdir(staging), []);
  });
