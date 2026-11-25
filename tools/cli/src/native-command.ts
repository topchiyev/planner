import { isAbsolute, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountEmailSchema, accountNameSchema } from '@planner/contracts';
import { publicIdSchema, signedInt64TextSchema } from '@planner/contracts/storage';
import { parsePreflightOptions } from '@planner/contracts/native';

type NativeCommand = 'setup' | 'status' | 'start' | 'stop' | 'restart' | 'verify-storage' | 'account-inspect' | 'account-confirm'
  | 'backup-create' | 'backup-restore' | 'backup-activate' | 'migration-prepare' | 'migration-preflight' | 'migration-verify' | 'migration-report'
  | 'migration-stage' | 'migration-resume' | 'migration-status' | 'migration-bootstrap-admin';
const operator = fileURLToPath(new URL('../../../apps/backend/dist/native/operate.js', import.meta.url));

const serviceName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;
const privatePath = (value: string) => isAbsolute(value) && value !== '/' && normalize(value) === value
  && Buffer.byteLength(value) < 4096 && !/[\p{Cc}]/u.test(value);

const manifestHash = /^[a-f0-9]{64}$/u;

function flagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith('--') || args.lastIndexOf(flag) !== index) throw new Error(`Specify one ${flag} value.`);
  args.splice(index, 2);
  return value;
}

export function runNativeCommand(command: NativeCommand, args: string[]) {
  let helperArgs: string[];
  try {
    if (command === 'setup') {
      const modeIndex = args.indexOf('--mode');
      const mode = args[modeIndex + 1];
      if (modeIndex < 0 || (mode !== 'fresh' && mode !== 'import')) {
        throw new Error('Choose a setup mode with --mode fresh or --mode import.');
      }
      const { json, ...options } = parsePreflightOptions([
        ...args.slice(0, modeIndex), ...args.slice(modeIndex + 2),
      ]);
      helperArgs = [command, JSON.stringify({ ...options, mode }), json ? 'json' : 'text'];
    } else if (command === 'migration-prepare' || command === 'migration-preflight') {
      const json = args.includes('--json');
      if (json) args.splice(args.indexOf('--json'), 1);
      let input;
      if (command === 'migration-prepare') {
        const archive = flagValue(args, '--archive');
        const workDir = flagValue(args, '--work-dir');
        if (!privatePath(archive) || !privatePath(workDir)) throw new Error('Specify absolute private archive and work paths.');
        input = { archive, workDir };
      } else {
        const manifest = flagValue(args, '--manifest');
        const sourceService = flagValue(args, '--source-service');
        const local = args.includes('--assets-root');
        if (local === args.includes('--asset-service') || !privatePath(manifest) || !serviceName.test(sourceService))
          throw new Error('Specify an absolute manifest, a source service, and exactly one asset source.');
        const assetSource = flagValue(args, local ? '--assets-root' : '--asset-service');
        if (!(local ? privatePath(assetSource) : serviceName.test(assetSource))) throw new Error('Specify a private asset directory or protected service.');
        input = { manifest, sourceService, ...(local ? { assetsRoot: assetSource } : { assetService: assetSource }) };
      }
      if (args.length) throw new Error('Unexpected migration command options.');
      helperArgs = [command, JSON.stringify(input), json ? 'json' : 'text'];
    } else if (command === 'migration-stage' || command === 'migration-resume' || command === 'migration-status') {
      const runId = publicIdSchema.parse(flagValue(args, '--run'));
      const format = args.includes('--format') ? flagValue(args, '--format') : 'text';
      if (args.length || (format !== 'text' && format !== 'json')) throw new Error('Expected --run ID and an optional --format text or json.');
      helperArgs = [command, JSON.stringify({ runId }), format];
    } else if (command === 'migration-verify' || command === 'migration-report') {
      const runId = flagValue(args, '--run');
      publicIdSchema.parse(runId);
      const report = command === 'migration-report';
      const format = report || args.includes('--format') ? flagValue(args, '--format') : 'text';
      if (format !== 'json' && (report || format !== 'text')) throw new Error('Specify --format json.');
      const paged = report && (args.includes('--offset') || args.includes('--limit'));
      const pageValue = (flag: string, fallback: number) => {
        const value = args.includes(flag) ? flagValue(args, flag) : String(fallback);
        if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${flag} value.`);
        return Number(value);
      };
      const page = paged ? { offset: pageValue('--offset', 0), limit: pageValue('--limit', 100) } : undefined;
      if (args.length || (page && (page.limit < 1 || page.limit > 1000))) throw new Error('Invalid migration verification options.');
      helperArgs = [command, JSON.stringify({ runId, page }), format];
    } else if (command === 'migration-bootstrap-admin') {
      const runId = publicIdSchema.parse(flagValue(args, '--run'));
      const rotate = args.includes('--rotate');
      if (rotate) args.splice(args.indexOf('--rotate'), 1);
      const json = args.includes('--json');
      if (json) args.splice(args.indexOf('--json'), 1);
      let recipient;
      if (args.includes('--source-user')) {
        recipient = { sourceUserId: signedInt64TextSchema.parse(flagValue(args, '--source-user')) };
      } else {
        const approval = args.indexOf('--approve-fallback');
        if (approval === -1) throw new Error('Specify the exact --source-user or explicitly approve a fallback administrator.');
        args.splice(approval, 1);
        recipient = { approveFallback: true, name: accountNameSchema.parse(flagValue(args, '--fallback-name')),
          email: accountEmailSchema.parse(flagValue(args, '--fallback-email')) };
      }
      if (args.length) throw new Error('Unexpected migration administrator options.');
      helperArgs = [command, JSON.stringify({ runId, rotate, ...recipient }), json ? 'json' : 'text'];
    } else if (command === 'backup-restore') {
      const archive = flagValue(args, '--archive');
      const fingerprint = flagValue(args, '--expect-manifest');
      if (!isAbsolute(archive) || normalize(archive) !== archive || !manifestHash.test(fingerprint)) {
        throw new Error('Specify an absolute private backup directory and the trusted manifest SHA-256.');
      }
      const { json, ...destination } = parsePreflightOptions(args);
      helperArgs = [command, JSON.stringify({ archive, fingerprint, destination }), json ? 'json' : 'text'];
    } else if (command === 'backup-activate') {
      const fingerprint = flagValue(args, '--expect-manifest');
      const json = args.includes('--json');
      const expected = json ? ['--json', '--yes'] : ['--yes'];
      if (!manifestHash.test(fingerprint) || args.sort().join(' ') !== expected.join(' ')) {
        throw new Error('Usage: plannerctl backup activate --expect-manifest SHA256 --yes [--json]');
      }
      helperArgs = [command, fingerprint, '--yes', json ? 'json' : 'text'];
    } else if (command === 'account-inspect' || command === 'account-confirm') {
      const operation = command === 'account-inspect' ? 'inspect' : 'confirm';
      const [id, ...flags] = args;
      const expected = operation === 'confirm' ? ['--yes'] : [];
      const json = flags[flags.length - 1] === '--json';
      if (json) flags.pop();
      if (!publicIdSchema.safeParse(id).success || flags.join(' ') !== expected.join(' ')) {
        throw new Error(`Usage: plannerctl accounts ${operation} APPROVAL_ID${operation === 'confirm' ? ' --yes' : ''} [--json]`);
      }
      helperArgs = [command, id, json ? 'json' : 'text'];
    } else {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
        throw new Error(`Usage: plannerctl ${command === 'verify-storage' ? 'storage verify' : command === 'backup-create' ? 'backup create' : command} [--json]`);
      }
      helperArgs = [command, args.length ? 'json' : 'text'];
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid native command options.');
    return 2;
  }
  const connectionOverrides = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const env = command.startsWith('migration-') ? Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const name = key.toUpperCase();
    return !name.startsWith('PG') && !connectionOverrides.includes(name);
  })) : undefined;
  const result = spawnSync(process.execPath, [operator, ...helperArgs], { stdio: 'inherit', env });
  if (result.status === null) console.error('The installed Planner operator command could not complete.');
  return result.status ?? 1;
}
