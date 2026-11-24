import { Busboy, type BusboyFileStream, type BusboyInstance } from '@fastify/busboy';
import type { IncomingHttpHeaders } from 'node:http';
import { Transform, type Readable } from 'node:stream';
import { maximumMediaBytes, maximumMediaEnvelope, mediaNameSchema } from '@planner/contracts';
import { MediaSizeError, type PrivateMediaStage } from '../../storage/blobs/private-store.js';
import { MediaRejection } from './errors.js';

type Received = Awaited<ReturnType<PrivateMediaStage['receive']>>;

const decimalSize = /^(?:0|[1-9][0-9]{0,8})$/u;
const allowedEncoding = (encoding: string) => ['7bit', '8bit', 'binary'].includes(encoding.toLowerCase());

export function mediaContentLength(headers: IncomingHttpHeaders) {
  const reported = headers['content-length'];
  if (reported === undefined) return null;
  if (!/^\d{1,12}$/u.test(reported)) throw new MediaRejection('input');
  const bytes = Number(reported);
  if (bytes > maximumMediaEnvelope) throw new MediaRejection('limit');
  return bytes;
}

export async function receiveMultipart(
  source: Readable, headers: IncomingHttpHeaders, stage: PrivateMediaStage, signal: AbortSignal,
) {
  const reportedEnvelope = mediaContentLength(headers);
  const type = headers['content-type'];
  if (!type || type.length > 256 || !/^multipart\/form-data(?:\s*;|$)/iu.test(type)) throw new MediaRejection('input');
  signal.throwIfAborted();

  let parser: BusboyInstance;
  try {
    parser = new Busboy({ headers: { 'content-type': type }, limits: {
      fieldNameSize: 32, fieldSize: 1024, fields: 2, files: 1, parts: 4, fileSize: maximumMediaBytes + 1,
      headerPairs: 8, headerSize: 2048,
    } });
  } catch { throw new MediaRejection('input'); }

  let envelope = 0;
  let file: BusboyFileStream | undefined;
  let received: Promise<Received> | undefined;
  let fileName: string | undefined;
  const fields = new Map<string, string>();
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      envelope += chunk.length;
      done(envelope > maximumMediaEnvelope ? new MediaRejection('limit') : null, chunk);
    },
  });
  let rejectParse: (failure: unknown) => void;
  let resolveParse: () => void;
  const parsed = new Promise<void>((resolve, reject) => { resolveParse = resolve; rejectParse = reject; });
  let failed = false;

  function fail(error: unknown) {
    if (failed) return;
    failed = true;
    source.unpipe(meter);
    source.pause();
    meter.unpipe(parser);
    meter.destroy();
    parser.destroy();
    file?.destroy();
    rejectParse(error);
  }
  const interrupted = () => fail(signal.reason);
  const broken = () => fail(new MediaRejection('input'));
  const earlyClose = () => { if (!source.readableEnded) broken(); };

  source.on('error', broken);
  source.on('close', earlyClose);
  signal.addEventListener('abort', interrupted, { once: true });
  meter.on('error', fail);
  parser.on('error', broken);
  parser.once('finish', () => resolveParse());
  parser.on('partsLimit', broken);
  parser.on('filesLimit', broken);
  parser.on('fieldsLimit', broken);
  parser.on('field', (name, value, nameTruncated, valueTruncated, encoding) => {
    if (failed) return;
    if ((name !== 'name' && name !== 'byteLength') || fields.has(name) || nameTruncated
        || valueTruncated || !allowedEncoding(encoding)) { broken(); return; }
    if (name === 'byteLength') {
      if (!decimalSize.test(value)) { broken(); return; }
      if (Number(value) > maximumMediaBytes) { fail(new MediaRejection('limit')); return; }
    }
    fields.set(name, value);
  });
  parser.on('file', (field, body, name, encoding) => {
    file = body;
    body.on('error', (error: NodeJS.ErrnoException) => {
      // A file iterator interrupted by its size check emits ABORT_ERR as it unwinds.
      if (error.code !== 'ABORT_ERR') broken();
    });
    if (failed || field !== 'file' || received || !allowedEncoding(encoding)) { body.destroy(); broken(); return; }
    body.on('limit', () => fail(new MediaRejection('limit')));
    fileName = name;
    received = stage.receive(body, maximumMediaBytes, signal);
    void received.catch((error) => fail(error instanceof MediaSizeError ? new MediaRejection('limit') : error));
  });

  try {
    source.pipe(meter).pipe(parser);
    await parsed;
    if (!received || (reportedEnvelope !== null && envelope !== reportedEnvelope)) throw new MediaRejection('input');
    const blob = await received;
    signal.throwIfAborted();
    const length = fields.get('byteLength');
    if (!length || !decimalSize.test(length)
        || blob.identity.byteLength !== Number(length) || file?.truncated) throw new MediaRejection('input');
    const name = mediaNameSchema.safeParse(fields.get('name') ?? (fileName || 'Attachment'));
    if (!name.success) throw new MediaRejection('input');
    return { ...blob, name: name.data };
  } catch (error) {
    fail(error);
    if (received) await Promise.allSettled([received]);
    throw error;
  } finally {
    signal.removeEventListener('abort', interrupted);
    source.off('error', broken);
    source.off('close', earlyClose);
  }
}
