import { isAbsolute, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicIdSchema } from '@planner/contracts/storage';
import { parsePreflightOptions } from '@planner/contracts/native';

type NativeCommand = 'setup' | 'status' | 'start' | 'stop' | 'restart' | 'verify-storage' | 'account-inspect' | 'account-confirm'
  | 'backup-create' | 'backup-restore' | 'backup-activate';
const operator = fileURLToPath(new URL('../../../apps/backend/dist/native/operate.js', import.meta.url));

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
  const result = spawnSync(process.execPath, [operator, ...helperArgs], { stdio: 'inherit' });
  if (result.status === null) console.error('The installed Planner operator command could not complete.');
  return result.status ?? 1;
}
