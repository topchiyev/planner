import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safeKey(key) {
  const parts = key.split('/');
  const uploadId = /^(?:[1-9][0-9]*|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
  assert.ok(parts.every((part) => part && part !== '.' && part !== '..' &&
    !/[<>:"\\|?*\p{Cc}]/u.test(part)), `Unsafe fixture path: ${key}`);
  assert.ok(uploadId.test(parts[2]), `Invalid fixture upload ID: ${key}`);
  if (parts[0] === 'private' && parts[1] === 'attachments') {
    assert.ok(parts.length === 4 || (parts.length === 5 && parts[3] === 'thumbnails' &&
      /^outside-(360|720)\.[a-z0-9]+$/.test(parts[4])), `Unknown attachment key: ${key}`);
  } else {
    assert.equal(parts[0], 'protected', `Unknown fixture key: ${key}`);
    assert.equal(parts.length, 4, `Unknown fixture key: ${key}`);
    if (parts[1] === 'user-avatars') {
      assert.match(parts[3], /^(original|cover-180)\.[a-z0-9]+$/);
    } else {
      assert.equal(parts[1], 'background-images', `Unknown fixture key: ${key}`);
      assert.match(parts[3], /^(original|outside-360)\.[a-z0-9]+$/);
    }
  }
}

function listFiles(root, prefix = '') {
  const normalized = new Set();
  const actual = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const key = prefix + entry.name;
    const folded = entry.name.normalize('NFC').toLowerCase();
    assert.ok(!normalized.has(folded), `Ambiguous fixture path: ${key}`);
    normalized.add(folded);
    if (entry.isDirectory()) {
      actual.push(...listFiles(root, key + '/'));
    } else {
      assert.ok(entry.isFile(), `Non-regular fixture asset: ${key}`);
      safeKey(key);
      actual.push(key);
    }
  }
  return actual;
}

export function checkAssets(root, assetManifest, sourceKeys) {
  assert.ok(lstatSync(root).isDirectory(), 'Expected a regular fixture asset directory');
  assert.equal(assetManifest.formatVersion, 1);
  const files = new Map();
  for (const entry of assetManifest.files) {
    safeKey(entry.key);
    assert.ok(!files.has(entry.key), `Duplicate fixture manifest key: ${entry.key}`);
    files.set(entry.key, entry);
  }
  assert.deepEqual([...files.keys()].sort(), Object.keys(sourceKeys).sort(), 'Database/manifest asset keys');

  const actual = new Set(listFiles(root));
  for (const [key, { size, sha256: expectedDigest }] of files) {
    assert.ok(actual.delete(key), `Absent fixture asset: ${key}`);
    const bytes = readFileSync(join(root, key));
    assert.equal(bytes.length, size, `Incorrect fixture asset size: ${key}`);
    assert.equal(sha256(bytes), expectedDigest, `Corrupt fixture asset: ${key}`);
    const source = sourceKeys[key];
    if (source.kind === 'attachment') {
      assert.equal(size, source.size, `Attachment original size: ${key}`);
    }
    if (source.kind === 'avatar' || source.kind === 'background') {
      assert.notEqual(size, source.size, `Expected encoded-size difference: ${key}`);
    }
  }
  assert.deepEqual([...actual], [], 'Unexpected fixture asset paths');
}
