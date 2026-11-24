import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import type { BlobIdentity } from '../../storage/blobs/private-store.js';
import { anchoredDirectory, BackupError, childPath, digestPattern, fdPath, fileChunks, optionalStat, verifyPart, type Owner, type Part } from './archive.js';

const { O_RDONLY, O_RDWR, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK, O_EXCL, O_CREAT } = constants;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

export async function openRestoreMedia({ staging, blobs, owner, fingerprint }: {
  staging: string; blobs: string; owner: Owner; fingerprint: string;
}) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || !digestPattern.test(fingerprint)) throw new BackupError();
  const destination = await anchoredDirectory(blobs, owner, 0o700);
  let stagingRoot: FileHandle | undefined;
  let scratch: FileHandle | undefined;
  const name = `.restore-${fingerprint}`;
  try {
    stagingRoot = await anchoredDirectory(staging, owner, 0o700);
    if ((await stagingRoot.stat()).dev !== (await destination.stat()).dev) throw new BackupError('Restore staging and blobs must share one filesystem.');
    const directory = childPath(stagingRoot, name);
    try { await mkdir(directory, { mode: 0o700 }); await stagingRoot.sync(); }
    catch (error) { if (code(error) !== 'EEXIST') throw error; }
    scratch = await open(directory, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
    const stat = await scratch.stat();
    if (stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== 0o700) throw new BackupError();
  } catch (error) { await Promise.allSettled([destination.close(), stagingRoot?.close(), scratch?.close()]); throw error; }
  const workspace = stagingRoot;
  const temporary = scratch;

  function asPart(identity: BlobIdentity) { return { sha256: identity.digest, byteLength: identity.byteLength }; }
  async function checkBlob(entry: Part) {
    if (!digestPattern.test(entry.sha256) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) throw new BackupError();
    const file = await open(childPath(destination, entry.sha256), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== owner.uid || stat.gid !== owner.gid || (stat.mode & 0o7777) !== 0o400
          || stat.nlink < 1 || stat.nlink > 2 || stat.size !== entry.byteLength) throw new BackupError('A destination media object has unsafe ownership or bytes.');
      await verifyPart(file, entry);
    } finally { await file.close(); }
  }
  async function discardPart(digest: string) {
    const temp = childPath(temporary, digest);
    const stat = await optionalStat(temp);
    if (!stat) return;
    if (!stat.isFile() || (stat.uid !== uid && stat.uid !== owner.uid) || (stat.gid !== gid && stat.gid !== owner.gid)
      || ![0o600, 0o400].includes(stat.mode & 0o7777) || stat.nlink < 1 || stat.nlink > 2) throw new BackupError();
    await unlink(temp);
  }
  return {
    async assertInventory(entries: readonly Part[]) {
      const expected = new Set(entries.map(({ sha256 }) => sha256));
      const live = await readdir(fdPath(destination));
      const partial = await readdir(fdPath(temporary));
      if (live.some((item) => !expected.has(item)) || partial.some((item) => !expected.has(item))) {
        throw new BackupError('The destination has media outside the bound restore inventory.');
      }
    },
    async writeBlob(input: FileHandle, entry: Part) {
      try {
        await checkBlob(entry);
        await verifyPart(input, entry);
        await discardPart(entry.sha256);
        return;
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      await discardPart(entry.sha256);
      const temp = childPath(temporary, entry.sha256);
      const file = await open(temp, O_RDWR | O_NOFOLLOW | O_EXCL | O_CREAT, 0o600);
      try {
        const hash = createHash('sha256');
        for await (const chunk of fileChunks(input, entry.byteLength)) { hash.update(chunk); await file.writeFile(chunk); }
        if (hash.digest('hex') !== entry.sha256) throw new BackupError('The restored media checksum did not match.');
        await verifyPart(file, entry);
        if (uid !== owner.uid || gid !== owner.gid) await file.chown(owner.uid, owner.gid);
        await file.chmod(0o400);
        await file.sync();
        try { await link(temp, childPath(destination, entry.sha256)); }
        catch (error) { if (code(error) !== 'EEXIST') throw error; await checkBlob(entry); }
        await destination.sync();
      } finally {
        try { await file.close(); } finally { await discardPart(entry.sha256); await temporary.sync(); }
      }
    },
    verifyBlob: (identity: BlobIdentity) => checkBlob(asPart(identity)),
    async close() {
      try {
        if ((await readdir(fdPath(temporary))).length === 0) {
          await rmdir(childPath(workspace, name));
          await workspace.sync();
        }
      } finally { await Promise.allSettled([temporary.close(), workspace.close(), destination.close()]); }
    },
  };
}
