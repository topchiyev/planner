import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePreflightOptions } from '@planner/contracts';

const minimumAvailableKiB = 524_288;

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
    console.log(`Planner ${version} native preflight passed on Ubuntu 24.04 amd64.`);
    console.log(`Application port ${options.appPort} and database port ${options.dbPort} are available.`);
    console.log(`Release filesystem has ${report.storage.releaseAvailableKiB} KiB available. State filesystem has ${report.storage.stateAvailableKiB} KiB available.`);
    console.log(`Ownership is ${report.ownership}. Installation is ${report.installation}.`);
    console.log(`Runtime configuration is ${runtime}. Readiness is ${report.runtime.readiness}.`);
  } else {
    console.error(message);
  }
  return ok ? 0 : 1;
}
