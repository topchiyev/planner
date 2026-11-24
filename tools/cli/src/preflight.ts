import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const valueOptions = new Set(['--public-url', '--app-port', '--db-port']);
const minimumAvailableKiB = 524_288;

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

  const origin = values.get('--public-url');
  const url = origin && /^https:\/\//iu.test(origin) && URL.parse(origin);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Specify an HTTPS public origin without credentials, path, query or fragment.');
  }
  const appPort = parsePort(values.get('--app-port'), 27_430);
  const dbPort = parsePort(values.get('--db-port'), 27_431);
  if (appPort === dbPort || dbPort === 27_017) throw new Error('Choose distinct ports and avoid the MongoDB default port 27017.');
  return { publicUrl: url.origin, appPort, dbPort, json };
}

export function runPreflight(args: string[], version: string) {
  let options;
  try {
    options = parsePreflightOptions(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid preflight options.';
    if (args.includes('--json')) console.log(JSON.stringify({ ok: false, version, failure: 'arguments', message }));
    else console.error(message);
    return 2;
  }

  // Resolve the release helper relative to this CLI so invocation never depends on the working directory.
  const helper = fileURLToPath(new URL('../../../lib/native-preflight', import.meta.url));
  const result = spawnSync(helper, ['report', String(options.appPort), String(options.dbPort)], {
    encoding: 'utf8', timeout: 15_000,
  });
  const fields = new Map<string, string>();
  for (const line of (result.stdout ?? '').split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter > 0) fields.set(line.slice(0, delimiter), line.slice(delimiter + 1));
  }
  const ok = result.status === 0;
  const failure = ok ? null : fields.get('failure') ?? 'native-preflight';
  const message = ok ? null : (result.stderr ?? '').trim() || 'The installed native preflight helper could not run.';
  const runtime = fields.get('runtime') ?? 'unknown';
  const availableKiB = (field: string) => Number(fields.get(field) ?? NaN);
  const report = {
    ok, version, publicUrl: options.publicUrl,
    host: { platform: process.platform, architecture: process.arch, supported: fields.get('host') === 'supported' },
    ports: {
      application: { port: options.appPort, state: fields.get('appPortState') ?? 'unknown' },
      database: { port: options.dbPort, state: fields.get('dbPortState') ?? 'unknown' },
    },
    storage: {
      minimumAvailableKiB,
      releaseAvailableKiB: availableKiB('releaseAvailableKiB'),
      stateAvailableKiB: availableKiB('stateAvailableKiB'),
    },
    ownership: fields.get('ownership') ?? 'unknown',
    installation: fields.get('installation') ?? 'unknown',
    runtime: { configuration: runtime, readiness: runtime === 'unconfigured' ? 'unavailable' : 'unknown' },
    failure, message,
  };
  if (options.json) {
    console.log(JSON.stringify(report));
  } else if (ok) {
    console.log(`Planner ${version} native preflight passed. Application port ${options.appPort} and database port ${options.dbPort} are available. Runtime configuration is ${runtime}.`);
  } else {
    console.error(message);
  }
  return ok ? 0 : 1;
}
