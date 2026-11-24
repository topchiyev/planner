import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { keyComponents, MigrationError, registerPath } from './manifest.js';

const blockSize = 512;
const metadataLimit = 64 * 1024;
const maximumEntries = 200_000;
const maximumExpandedBytes = 64 * 1024 ** 3;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type TarEntry = { path: string; kind: 'file' | 'directory'; size: number };
type Visit = (entry: TarEntry, contents: AsyncIterable<Buffer>) => Promise<void>;
type Extended = { path?: string; size?: number };

function invalid() {
  return new MigrationError('archive-layout', 'The migration archive contains an invalid entry or unsupported format.');
}

function excessive() {
  return new MigrationError('archive-limit', 'The migration archive exceeds its entry or byte limit.');
}

function text(bytes: Buffer) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

const zero = (bytes: Buffer) => bytes.every((byte) => byte === 0);

function octal(bytes: Buffer) {
  const contents = text(bytes).trim();
  if (!/^[0-7]+$/u.test(contents)) throw invalid();
  const number = Number.parseInt(contents, 8);
  if (!Number.isSafeInteger(number)) throw excessive();
  return number;
}

function readHeader(bytes: Buffer) {
  const magic = bytes.subarray(257, 263).toString('ascii');
  if (magic !== 'ustar\0' && magic !== 'ustar ') throw invalid();
  const expected = octal(bytes.subarray(148, 156));
  const actual = bytes.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (actual !== expected) throw invalid();
  const name = text(bytes.subarray(0, 100));
  const prefix = magic === 'ustar\0' ? text(bytes.subarray(345, 500)) : '';
  return { path: prefix ? prefix + '/' + name : name,
    type: bytes[156] ? String.fromCharCode(bytes[156]) : '0', size: octal(bytes.subarray(124, 136)) };
}

function pax(bytes: Buffer) {
  const result: Extended = {};
  const seen = new Set<string>();
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(32, position);
    if (space <= position || space - position > 5) throw invalid();
    const lengthText = bytes.toString('ascii', position, space);
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw invalid();
    const end = position + Number(lengthText);
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) throw invalid();
    const entry = decoder.decode(bytes.subarray(space + 1, end - 1));
    const equals = entry.indexOf('=');
    const key = entry.slice(0, equals);
    const value = entry.slice(equals + 1);
    if (equals < 1 || seen.has(key)) throw invalid();
    seen.add(key);
    if (key === 'path') result.path = value;
    else if (key === 'size') {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalid();
      result.size = Number(value);
      if (!Number.isSafeInteger(result.size) || result.size > maximumExpandedBytes) throw excessive();
    } else if (!['mtime', 'ctime', 'atime'].includes(key) || !/^-?[0-9]+(?:\.[0-9]+)?$/u.test(value)) throw invalid();
    position = end;
  }
  if (!seen.size) throw invalid();
  return result;
}

class StreamBlocks {
  #tail = Buffer.alloc(0);
  #read = 0;
  #input: AsyncIterator<Buffer>;

  constructor(stream: Readable, readonly signal?: AbortSignal) {
    this.#input = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async next() {
    this.signal?.throwIfAborted();
    if (this.#tail.length) return true;
    const value = await this.#input.next();
    if (value.done) return false;
    this.#tail = Buffer.from(value.value);
    this.#read += this.#tail.length;
    if (this.#read > maximumExpandedBytes) throw excessive();
    return true;
  }

  async *chunks(size: number) {
    let remaining = size;
    while (remaining > 0) {
      if (!await this.next()) throw invalid();
      const consumed = Math.min(remaining, this.#tail.length);
      const head = this.#tail.subarray(0, consumed);
      this.#tail = this.#tail.subarray(consumed);
      remaining -= consumed;
      yield head;
    }
  }

  async buffer(size: number) {
    const chunks: Buffer[] = [];
    for await (const chunk of this.chunks(size)) chunks.push(chunk);
    return Buffer.concat(chunks, size);
  }

  async finish() {
    while (await this.next()) {
      if (!zero(this.#tail)) throw invalid();
      this.#tail = Buffer.alloc(0);
    }
  }
}

export async function scanTar(file: FileHandle, visit: Visit, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const signature = Buffer.alloc(2);
  if ((await file.read(signature, 0, signature.length, 0)).bytesRead !== 2) throw invalid();
  const source = createReadStream('/proc/self/fd/' + file.fd);
  const gunzip = signature[0] === 0x1f && signature[1] === 0x8b ? createGunzip() : undefined;
  if (gunzip) {
    source.once('error', (error) => gunzip.destroy(error));
    source.pipe(gunzip);
  }
  const stream = gunzip ?? source;
  const input = new StreamBlocks(stream, signal);
  const known = new Map<string, string>();
  const entries = new Map<string, TarEntry['kind']>();
  const directories = new Set<string>();
  let extended: Extended | undefined;
  try {
    for (let count = 0; count <= maximumEntries; count++) {
      const block = await input.buffer(blockSize);
      if (zero(block)) {
        if (extended || !zero(await input.buffer(blockSize))) throw invalid();
        await input.finish();
        return;
      }
      if (count === maximumEntries) throw excessive();
      const header = readHeader(block);
      const type = header.type;
      if (type === 'x' || type === 'L') {
        if (extended || !header.size || header.size > metadataLimit) throw invalid();
        const bytes = await input.buffer(header.size);
        if (type === 'x') extended = pax(bytes);
        else {
          const end = bytes.indexOf(0);
          if (end < 1 || !zero(bytes.subarray(end))) throw invalid();
          extended = { path: decoder.decode(bytes.subarray(0, end)) };
        }
        if (!zero(await input.buffer((blockSize - header.size % blockSize) % blockSize))) throw invalid();
        continue;
      }

      if (type !== '0' && type !== '5') throw invalid();
      const kind = type === '0' ? 'file' : 'directory';
      let path = extended?.path ?? header.path;
      const size = extended?.size ?? header.size;
      extended = undefined;
      if (kind === 'directory' && path.endsWith('/')) path = path.slice(0, -1);
      const parts = keyComponents(path);
      registerPath(known, path);
      if (!Number.isSafeInteger(size) || size > maximumExpandedBytes) throw excessive();
      if ((kind === 'directory' ? size !== 0 : directories.has(path)) || entries.has(path)) throw invalid();
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (entries.get(parent) === 'file') throw invalid();
        directories.add(parent);
      }
      entries.set(path, kind);
      let consumed = 0;
      async function* contents() {
        for await (const chunk of input.chunks(size)) {
          consumed += chunk.length;
          yield chunk;
        }
      }
      await visit({ path, kind, size }, contents());
      if (consumed !== size || !zero(await input.buffer((blockSize - size % blockSize) % blockSize))) throw invalid();
    }
  } catch (error) {
    if (error instanceof MigrationError || signal?.aborted) throw error;
    throw invalid();
  } finally {
    stream.destroy();
    if (stream !== source) source.destroy();
  }
}
