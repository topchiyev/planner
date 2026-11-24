import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { MediaSizeError, MediaStorageError, type BlobIdentity, type PrivateMediaStage } from '../../storage/blobs/private-store.js';
import { MediaRejection, reserveSlots } from './errors.js';

export const imageTypes = { JPEG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', WEBP: 'image/webp' } as const;
type ImageFormat = keyof typeof imageTypes;
export type MediaVariants = Readonly<{ small: BlobIdentity; large: BlobIdentity }>;
export const maximumDerivativeBytes = 8 * 1024 * 1024;

export function detectImage(header: Buffer): ImageFormat | undefined {
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'JPEG';
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'PNG';
  const head = header.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return 'GIF';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'WEBP';
  return undefined;
}

function decode(executable: string, script: string, format: ImageFormat, handles: FileHandle[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-I', '-B', script, format], {
      stdio: ['ignore', 'ignore', 'ignore', ...handles.map(({ fd }) => fd)],
      shell: false, cwd: '/', env: { LC_ALL: 'C.UTF-8' },
    });
    let expired = false;
    const abort = () => { child.kill('SIGKILL'); };
    const timer = setTimeout(() => { expired = true; abort(); }, 8_000);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code, terminatingSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (expired || code === 65 || terminatingSignal === 'SIGXCPU' || terminatingSignal === 'SIGXFSZ') {
        reject(new MediaRejection('image'));
      } else if (code === 0) resolve();
      else reject(new MediaStorageError());
    });
  });
}

export function createMediaDecoder(script: string, executable = '/usr/bin/python3') {
  const reserve = reserveSlots(2);
  return async (stage: PrivateMediaStage, format: ImageFormat, signal: AbortSignal): Promise<MediaVariants> => {
    const release = reserve();
    const handles: FileHandle[] = [];
    try {
      handles.push(await stage.openPart('original'));
      handles.push(await stage.createPart('small'));
      handles.push(await stage.createPart('large'));
      await decode(executable, script, format, handles, signal);
      const small = await stage.seal('small', handles[1], maximumDerivativeBytes);
      const large = await stage.seal('large', handles[2], maximumDerivativeBytes);
      if (!small.byteLength || !large.byteLength) throw new MediaStorageError();
      return { small, large };
    } catch (error) {
      if (error instanceof MediaSizeError) throw new MediaRejection('image');
      throw error;
    } finally { await Promise.allSettled(handles.map((handle) => handle.close())); release(); }
  };
}

export type MediaDecoder = ReturnType<typeof createMediaDecoder>;
