#!/usr/bin/env node
import { PLANNER_VERSION } from '@planner/contracts';

if (process.argv[2] === '--version') {
  console.log(PLANNER_VERSION);
}
