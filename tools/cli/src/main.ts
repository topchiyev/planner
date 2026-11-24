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
} else {
  console.error('Usage: plannerctl preflight|setup|status|start|stop|restart|--version');
  process.exitCode = 2;
}
