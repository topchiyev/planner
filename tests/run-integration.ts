import { spawnSync } from 'node:child_process';
import { assertOwnedMongoEnvironment } from './support/mongo-environment.ts';

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status ?? 1;
}

try {
  assertOwnedMongoEnvironment(process.env, process.argv.slice(2));
  const buildExit = run('npm', ['run', 'build']);
  process.exitCode = buildExit || run(process.execPath, [
    '--import', 'tsx', '--test', 'tests/health.test.mjs', 'tests/integration/**/*.test.{ts,mjs}',
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Integration runner failed.');
  process.exitCode = 1;
}
