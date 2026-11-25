import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Readable as Source, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Owner } from '../application/backup/archive.js';
import type { WriterLease } from '../application/command-gate/writer-lease.js';
import { imageTypes, maximumDerivativeBytes, type MediaDecoder } from '../application/media/decoder.js';
import { MediaRejection } from '../application/media/errors.js';
import { originalType } from '../application/media/records.js';
import { MigrationError } from '../application/migration/manifest.js';
import { prepareMigrationMedia, receiveMigrationMedia, type MigrationMediaPublisher } from '../application/migration/media-publication.js';
import { digestPattern, type PrivateMediaStage, type PrivateMediaStore } from '../storage/blobs/private-store.js';

const identitySchema = z.strictObject({ digest: z.string().regex(digestPattern), byteLength: z.number().int().nonnegative() });
const variantSchema = identitySchema.extend({ byteLength: z.number().int().min(1).max(maximumDerivativeBytes) });
const preparedSchema = identitySchema.extend({ mimeType: z.enum([originalType, ...Object.values(imageTypes)]),
  variants: z.strictObject({ small: variantSchema, large: variantSchema }).nullable() })
  .refine(({ mimeType, variants }) => (mimeType === originalType) === (variants === null));
const replySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepared'), media: preparedSchema }),
  z.strictObject({ action: z.literal('published') }),
  z.strictObject({ action: z.literal('failed'), reason: z.enum(['image', 'integrity', 'target']) }),
]);
const maxProtocolBytes = 4096;

function mediaFailure() {
  return new MigrationError('target-write', 'The private migration media worker could not complete its operation.');
}

// Each end sends at most three small messages. Bytes for the asset itself use a separate pipe.
function messages(input: Readable) {
  let pending = Buffer.alloc(0);
  let size = 0;
  const lines = new Transform({ readableObjectMode: true,
    transform(chunk: Buffer, _encoding, done) {
      try {
        size += chunk.length;
        if (size > maxProtocolBytes) throw mediaFailure();
        pending = Buffer.concat([pending, chunk]);
        let newline = pending.indexOf(10);
        while (newline !== -1) {
          this.push(JSON.parse(pending.subarray(0, newline).toString('utf8')));
          pending = pending.subarray(newline + 1);
          newline = pending.indexOf(10);
        }
        done();
      } catch { done(mediaFailure()); }
    },
    flush(done) { done(pending.length ? mediaFailure() : undefined); },
  });
  input.once('error', () => lines.destroy(mediaFailure()));
  lines.on('error', () => { input.destroy(); });
  const iterator = input.pipe(lines)[Symbol.asyncIterator]();
  return async () => {
    const value = await iterator.next();
    if (value.done) throw mediaFailure();
    return value.value as unknown;
  };
}

function send(output: Writable, packet: unknown) {
  return new Promise<void>((resolve, reject) => {
    output.write(`${JSON.stringify(packet)}\n`, (error) => { if (error) reject(mediaFailure()); else resolve(); });
  });
}

export function nativeMigrationMediaPublisher(owner: Owner, lease: WriterLease,
  script = fileURLToPath(new URL('./migration-media-worker.js', import.meta.url)), scriptArgs: string[] = []): MigrationMediaPublisher {
  if (!Number.isSafeInteger(owner.uid) || owner.uid < 1 || !Number.isSafeInteger(owner.gid) || owner.gid < 1) throw mediaFailure();
  return async (expected, read, signal) => {
    signal.throwIfAborted();
    const child = spawn('/usr/bin/setpriv', [`--reuid=${owner.uid}`, `--regid=${owner.gid}`, '--clear-groups', '--no-new-privs',
      '--', process.execPath, script, ...scriptArgs], {
      cwd: '/', env: { LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore', lease.inheritedDescriptor(), 'pipe'],
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.once('error', () => { /* The close event reaps failed execs too. */ });
    const control = child.stdio[4] as Writable;
    control.on('error', () => {});
    child.stdin!.on('error', () => {});
    const readReply = messages(child.stdout!);
    let published = false;
    let closing: Promise<void> | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    function boundExit() {
      watchdog ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
      watchdog.unref();
    }
    const abort = () => { boundExit(); control.destroy(); child.stdin!.destroy(); };
    signal.addEventListener('abort', abort, { once: true });

    function close() {
      return closing ??= (async () => {
        boundExit();
        try {
          if (published && !signal.aborted) await send(control, { action: 'release' });
          else abort();
          const code = await closed;
          if (published && !signal.aborted && code !== 0) throw mediaFailure();
        } finally {
          abort();
          await closed;
          clearTimeout(watchdog);
          signal.removeEventListener('abort', abort);
        }
      })();
    }

    async function reply<T extends 'prepared' | 'published'>(action: T) {
      const parsed = replySchema.safeParse(await readReply());
      if (!parsed.success) throw mediaFailure();
      if (parsed.data.action === 'failed') {
        if (parsed.data.reason === 'image' || parsed.data.reason === 'integrity')
          throw new MigrationError('asset-integrity', 'The media worker could not validate the verified original.');
        throw mediaFailure();
      }
      if (parsed.data.action !== action) throw mediaFailure();
      return parsed.data as Extract<z.infer<typeof replySchema>, { action: T }>;
    }

    try {
      await send(control, { action: 'receive', expected: identitySchema.parse(expected) });
      await read(async (bytes, reading) => { await pipeline(Source.from(bytes), child.stdin!, { signal: reading }); }, signal);
      const { media } = await reply('prepared');
      signal.throwIfAborted();
      return { media, close, async publish() {
        signal.throwIfAborted();
        lease.assertHeld();
        await send(control, { action: 'publish' });
        await reply('published');
        published = true;
      } };
    } catch (error) { await close(); throw error; }
  };
}

const receiveSchema = z.strictObject({ action: z.literal('receive'), expected: identitySchema });
const publishSchema = z.strictObject({ action: z.literal('publish') });
const releaseSchema = z.strictObject({ action: z.literal('release') });

export async function runMigrationMediaWorker(input: Readable, control: Readable, output: Writable,
  openStore: () => Promise<PrivateMediaStore>, decode: MediaDecoder) {
  const controller = new AbortController();
  const cancel = () => { controller.abort(); input.destroy(); };
  control.once('end', cancel);
  control.once('close', cancel);
  output.once('error', cancel);
  const readMessage = messages(control);
  let store: PrivateMediaStore | undefined;
  let stage: PrivateMediaStage | undefined;
  let unpin: (() => void) | undefined;
  try {
    const { expected } = receiveSchema.parse(await readMessage());
    store = await openStore();
    stage = await store.stage();
    const received = await receiveMigrationMedia(stage, expected, input, controller.signal);
    const { media, parts } = await prepareMigrationMedia(stage, received, decode, controller.signal);
    await send(output, { action: 'prepared', media });
    publishSchema.parse(await readMessage());
    controller.signal.throwIfAborted();
    unpin = await stage.publish(parts);
    controller.signal.throwIfAborted();
    await send(output, { action: 'published' });
    releaseSchema.parse(await readMessage());
  } catch (error) {
    const reason = error instanceof MediaRejection && error.kind === 'image' ? 'image'
      : error instanceof MigrationError && error.fault === 'asset-integrity' ? 'integrity' : 'target';
    if (!controller.signal.aborted) await send(output, { action: 'failed', reason }).catch(() => undefined);
    throw mediaFailure();
  } finally {
    try { await stage?.dispose(); } finally {
      unpin?.();
      control.destroy();
      await store?.close();
    }
  }
}
