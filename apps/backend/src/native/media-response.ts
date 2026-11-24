import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MediaService } from '../application/media/service.js';
import { derivativeType, originalType } from '../application/media/records.js';

type Opened = Awaited<ReturnType<MediaService['openForRead']>>;
type Range = { start: number; end: number };

function requestedRange(header: string, size: number): Range | null {
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/u.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size
    ? { start, end: Math.min(end, size - 1) } : null;
}

function downloadName(name: string) {
  const clean = name.replace(/[\p{Cc}\p{Cs}\/\\]/gu, '_');
  const fallback = clean.replace(/[^a-zA-Z0-9._ -]/gu, '_') || 'attachment';
  const encoded = encodeURIComponent(clean).replace(/['()*]/gu, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function sendPrivateMedia(request: FastifyRequest, reply: FastifyReply, opened: Opened) {
  const { file, identity, id, revision, download, name } = opened;
  let streaming = false;
  try {
    if (reply.raw.destroyed || request.raw.aborted) return;
    const size = identity.byteLength;
    const etag = '"' + createHash('sha256').update(JSON.stringify([id, revision, identity.digest])).digest('hex') + '"';
    reply.headers({
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Accept-Ranges': 'bytes', ETag: etag,
    });
    if (request.headers['if-none-match']?.split(',').some((value) => ['*', etag, 'W/' + etag].includes(value.trim()))) {
      return reply.code(304).send();
    }

    const range = request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)
      ? requestedRange(request.headers.range, size) : undefined;
    if (range === null) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    const length = range ? range.end - range.start + 1 : size;
    reply.type(download ? originalType : derivativeType).header('Content-Length', length);
    if (download) reply.header('Content-Disposition', downloadName(name));
    if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    if (request.method === 'HEAD') return reply.send();
    if (length === 0) return reply.send(Buffer.alloc(0));

    const stream = file.createReadStream({ ...(range ?? { start: 0 }), autoClose: true });
    const abort = () => { stream.destroy(); };
    reply.raw.once('close', abort);
    stream.once('close', () => { reply.raw.off('close', abort); });
    try {
      const result = reply.send(stream);
      streaming = true;
      return result;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } finally { if (!streaming) await file.close(); }
}
