#!/usr/bin/env node
import { PLANNER_VERSION } from '@planner/contracts';
import { runNativeCommand } from './native-command.js';
import { runPreflight } from './preflight.js';

const [command, ...args] = process.argv.slice(2);
if (command === '--version') {
  console.log(PLANNER_VERSION);
} else if (command === 'preflight') {
  process.exitCode = runPreflight(args, PLANNER_VERSION);
} else if (command === 'setup' || command === 'status' || command === 'start'
    || command === 'stop' || command === 'restart') {
  process.exitCode = runNativeCommand(command, args);
} else if (command === 'accounts' && (args[0] === 'inspect' || args[0] === 'confirm')) {
  process.exitCode = runNativeCommand(args[0] === 'inspect' ? 'account-inspect' : 'account-confirm', args.slice(1));
} else if (command === 'storage' && args[0] === 'verify') {
  process.exitCode = runNativeCommand('verify-storage', args.slice(1));
} else {
  console.error('Usage: plannerctl preflight|setup|status|start|stop|restart|storage verify|accounts inspect|accounts confirm|--version');
  process.exitCode = 2;
}
