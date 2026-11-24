import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicIdSchema } from '@planner/contracts/storage';
import { parsePreflightOptions } from '@planner/contracts/native';

type NativeCommand = 'setup' | 'status' | 'start' | 'stop' | 'restart' | 'verify-storage' | 'account-inspect' | 'account-confirm';
const operator = fileURLToPath(new URL('../../../apps/backend/dist/native/operate.js', import.meta.url));

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
        throw new Error(`Usage: plannerctl ${command === 'verify-storage' ? 'storage verify' : command} [--json]`);
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
