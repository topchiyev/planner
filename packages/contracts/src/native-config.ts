import { z } from 'zod';

export const defaultAppPort = 27_430;
export const defaultDatabasePort = 27_431;
const valueOptions = new Set(['--public-url', '--app-port', '--db-port']);

function canonicalNativeOrigin(value: string) {
  const authority = /^https:\/\/([^/?#\\]+)\/?$/iu.exec(value)?.[1];
  if (!authority || authority.includes('@') || /\s/u.test(authority)) return undefined;
  return URL.parse(value)?.origin;
}

function parsePort(value: string | undefined, defaultPort: number) {
  if (value === undefined) return defaultPort;
  if (!/^[1-9]\d{0,4}$/u.test(value) || Number(value) > 65_535) {
    throw new Error('Ports must be integers from 1 to 65535.');
  }
  return Number(value);
}

export function parsePreflightOptions(args: string[]) {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--json' && !json) {
      json = true;
      continue;
    }
    if (!valueOptions.has(option) || values.has(option) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Usage: plannerctl preflight --public-url URL [--app-port N] [--db-port N] [--json]');
    }
    values.set(option, args[++index]);
  }

  const publicUrl = canonicalNativeOrigin(values.get('--public-url') ?? '');
  if (!publicUrl) throw new Error('Specify an HTTPS public origin without credentials, path, query or fragment.');
  const appPort = parsePort(values.get('--app-port'), defaultAppPort);
  const dbPort = parsePort(values.get('--db-port'), defaultDatabasePort);
  if (appPort === dbPort || dbPort === 27_017) throw new Error('Choose distinct ports and avoid the MongoDB default port 27017.');
  return { publicUrl, appPort, dbPort, json };
}

export const nativeSetupOptions = z.strictObject({
  publicUrl: z.string().refine((value) => canonicalNativeOrigin(value) === value),
  appPort: z.number().int().min(1).max(65_535),
  dbPort: z.number().int().min(1).max(65_535).refine((value) => value !== 27_017),
  mode: z.enum(['fresh', 'import']),
}).refine(({ appPort, dbPort }) => appPort !== dbPort);

export const nativeInstallationConfig = z.strictObject({
  ...nativeSetupOptions.shape,
  formatVersion: z.literal(1),
  installationId: z.uuidv4(),
}).refine(({ appPort, dbPort }) => appPort !== dbPort);

export type NativeSetupOptions = z.infer<typeof nativeSetupOptions>;
export type NativeInstallationConfig = z.infer<typeof nativeInstallationConfig>;
