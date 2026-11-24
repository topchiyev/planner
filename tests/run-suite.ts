import { spawnSync } from 'node:child_process';
import { assertOwnedMongoEnvironment } from './support/mongo-environment.ts';

type Step = [command: string, args: string[]];

const npm = (...args: string[]): Step => ['npm', args];
const tests = (...files: string[]): Step => [process.execPath, ['--import', 'tsx', '--test', ...files]];
const build = npm('run', 'build');
const buildContracts = npm('run', 'build', '--workspace', '@planner/contracts');
const unit = tests('tests/unit/**/*.test.{ts,mjs}');
const health = tests('tests/health.test.mjs');
const shell = tests('tests/shell.test.mjs');
const verify = [npm('run', 'typecheck'), build, unit, health];

const suites = new Map<string, Step[]>([
  ['unit', [buildContracts, unit]],
  ['health', [health]],
  ['shell', [shell]],
  ['e2e', [build, shell]],
  ['integration', [build, tests('tests/health.test.mjs', 'tests/integration/**/*.test.{ts,mjs}')]],
  ['verify', verify],
  ['verify:clean', [npm('ci', '--strict-peer-deps'), npm('ls', '--all'), ...verify]],
]);

try {
  const [name = '', ...args] = process.argv.slice(2);
  assertOwnedMongoEnvironment(process.env, args);
  const suite = suites.get(name);
  if (!suite) throw new Error('Choose a Planner test suite.');
  for (const [command, commandArgs] of suite) {
    const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
    const status = result.status ?? 1;
    if (status !== 0) {
      process.exitCode = status;
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Planner test runner failed.');
  process.exitCode = 1;
}
