import { createHash } from 'node:crypto';
import { migrationAssetsSchema, migrationCaptureSchema, type MigrationAsset, type MigrationCapture } from '@planner/contracts';
import { sourceAssetIdSchema } from '@planner/contracts/storage';

export type MigrationFault = 'capture-format' | 'source-release' | 'source-edition' | 'capture-integrity'
  | 'archive-layout' | 'archive-limit' | 'asset-manifest' | 'asset-key' | 'asset-integrity'
  | 'source-service' | 'source-role' | 'source-catalog' | 'source-ledger' | 'source-read'
  | 'source-changed' | 'target-setup' | 'target-capacity' | 'target-write'
  | 'activation-conflict' | 'verification-incomplete' | 'verification-blocked' | 'approval-required' | 'approval-invalid';

export class MigrationError extends Error {
  constructor(readonly fault: MigrationFault, message: string) { super(message); }
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const captureManifestLimit = 64 * 1024;
export const assetManifestLimit = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const unsafeComponent = /[<>:"\\|?*\p{Cc}]/u;

function json(bytes: Buffer, limit: number, label: MigrationFault) {
  try {
    if (!bytes.length || bytes.length > limit) throw new Error();
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new MigrationError(label, 'The migration manifest is invalid or too large.');
  }
}

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function readCaptureManifest(bytes: Buffer) {
  const value = json(bytes, captureManifestLimit, 'capture-format');
  if (object(value) && object(value.source)) {
    if (value.source.edition !== 'community')
      throw new MigrationError('source-edition', 'Only PLANKA Community inputs are supported.');
    if (value.source.release !== '2.3.0' && value.source.release !== '2.3.1')
      throw new MigrationError('source-release', 'The declared PLANKA release is unsupported.');
  }
  const parsed = migrationCaptureSchema.safeParse(value);
  if (!parsed.success) throw new MigrationError('capture-format', 'The migration capture manifest is invalid.');
  return parsed.data;
}

export function keyComponents(path: string) {
  const components = path.split('/');
  if (Buffer.byteLength(path) > 2048 || components.some((part) =>
    !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || unsafeComponent.test(part))) {
    throw new MigrationError('asset-key', 'The migration input contains an unsafe path.');
  }
  return components;
}

export function assetKeyKind(key: string) {
  const [scope, type, id, leaf, derived, ...extra] = keyComponents(key);
  if (sourceAssetIdSchema.safeParse(id).success && leaf && extra.length === 0) {
    if (scope === 'private' && type === 'attachments') {
      if (!derived) return 'original' as const;
      if (leaf === 'thumbnails' && /^outside-(360|720)\.[a-z0-9]+$/u.test(derived)) return 'derivative' as const;
    }
    if (!derived && scope === 'protected') {
      if ((type === 'background-images' || type === 'user-avatars') && /^original\.[a-z0-9]+$/u.test(leaf)) return 'original' as const;
      if (type === 'background-images' && /^outside-360\.[a-z0-9]+$/u.test(leaf)
          || type === 'user-avatars' && /^cover-180\.[a-z0-9]+$/u.test(leaf)) return 'derivative' as const;
    }
  }
  throw new MigrationError('asset-key', 'The migration input contains an unsupported asset path.');
}

export function registerPath(known: Map<string, string>, path: string) {
  const components = keyComponents(path);
  for (let i = 1; i <= components.length; i++) {
    const exact = components.slice(0, i).join('/');
    const folded = exact.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
    const existing = known.get(folded);
    if (existing !== undefined && existing !== exact)
      throw new MigrationError('asset-key', 'The migration input contains ambiguous case or Unicode names.');
    known.set(folded, exact);
  }
}

export function readAssetManifest(bytes: Buffer, capture: MigrationCapture) {
  if (sha256(bytes) !== capture.asset.manifestSha256)
    throw new MigrationError('capture-integrity', 'The asset manifest checksum differs from the capture.');
  const parsed = migrationAssetsSchema.safeParse(json(bytes, assetManifestLimit, 'asset-manifest'));
  if (!parsed.success) throw new MigrationError('asset-manifest', 'The migration asset manifest is invalid.');
  const paths = new Map<string, string>();
  const entries = new Map<string, MigrationAsset>();
  for (const entry of parsed.data.files) {
    assetKeyKind(entry.key);
    registerPath(paths, entry.key);
    if (entries.has(entry.key) || (capture.asset.kind === 'object') !== (entry.versionId !== undefined))
      throw new MigrationError('asset-manifest', 'The asset manifest contains a duplicate or unbound asset.');
    entries.set(entry.key, entry);
  }
  return entries;
}
