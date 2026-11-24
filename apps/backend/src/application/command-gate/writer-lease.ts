import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

export class WriterOwnershipError extends Error {}

interface Ownership {
  uid: number;
  gid: number;
}

class WriterLease {
  #descriptor: number | undefined;

  constructor(descriptor: number) {
    this.#descriptor = descriptor;
  }

  get held() { return this.#descriptor !== undefined; }

  assertHeld() {
    if (!this.held) throw new WriterOwnershipError('Planner writer ownership has ended.');
  }

  transfer() {
    const descriptor = this.#descriptor;
    if (descriptor === undefined) throw new WriterOwnershipError('Planner writer ownership has ended.');
    this.#descriptor = undefined;
    return new WriterLease(descriptor);
  }

  release() {
    const descriptor = this.#descriptor;
    if (descriptor === undefined) return;
    this.#descriptor = undefined;
    closeSync(descriptor);
  }
}
export type { WriterLease };

function checkDirectory(info: Stats, expected: Ownership, validMode: (mode: number) => boolean) {
  if (!info.isDirectory() || info.uid !== expected.uid || info.gid !== expected.gid || !validMode(info.mode & 0o7777)) {
    throw new WriterOwnershipError('The Planner writer directory has unexpected ownership or permissions.');
  }
  return info;
}

function sameInode(first: Stats, second: Stats) {
  return first.ino === second.ino && first.dev === second.dev;
}

export function acquireWriterDirectory(directory: string, owner: Ownership, parentOwner: Ownership): WriterLease {
  const parent = dirname(directory);
  const checkParent = () => checkDirectory(lstatSync(parent), parentOwner, (mode) => (mode & 0o022) === 0);
  const checkWriter = (info: Stats) => checkDirectory(info, owner, (mode) => mode === 0o750);
  let descriptor: number | undefined;
  try {
    const initialParent = checkParent();
    const initialDirectory = checkWriter(lstatSync(directory));
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = checkWriter(fstatSync(descriptor));
    if (!sameInode(initialDirectory, opened)) throw new WriterOwnershipError('The Planner writer directory changed.');

    // flock's inherited fd and this process's fd share one Linux open file description.
    const result = spawnSync('/usr/bin/flock', ['-nx', '-E', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor], timeout: 1_000,
    });
    if (result.status === 75) throw new WriterOwnershipError('Another Planner writer already owns this installation.');
    if (result.status !== 0 || !sameInode(checkParent(), initialParent) || !sameInode(checkWriter(lstatSync(directory)), opened)) {
      throw new WriterOwnershipError('The Planner writer lock could not be verified.');
    }
    const lease = new WriterLease(descriptor);
    descriptor = undefined;
    return lease;
  } catch (error) {
    if (error instanceof WriterOwnershipError) throw error;
    throw new WriterOwnershipError('The Planner writer lock could not be verified.', { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
