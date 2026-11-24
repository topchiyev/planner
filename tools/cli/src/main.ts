#!/usr/bin/env node
import { PLANNER_VERSION } from '@planner/contracts';
import { runPreflight } from './preflight.js';

if (process.argv[2] === '--version') {
  console.log(PLANNER_VERSION);
} else if (process.argv[2] === 'preflight') {
  process.exitCode = runPreflight(process.argv.slice(3), PLANNER_VERSION);
}
