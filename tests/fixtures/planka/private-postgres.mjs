import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function startFixturePostgres(context) {
  const socketRoot = mkdtempSync('/tmp/planner-planka-');
  const data = join(socketRoot, 'db');
  const port = '5432';
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PG'))),
    LC_ALL: 'C',
    TZ: 'UTC',
  };
  const bin = (name) => {
    const directory = process.env.PLANNER_TEST_PG_BIN_DIR;
    return directory ? join(directory, name) : name;
  };
  const options = { env, encoding: 'utf8', cwd: socketRoot, timeout: 15_000 };
  let server;
  let closed;
  let serverError;
  let log = '';

  context.after(async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      // SIGINT requests PostgreSQL's fast shutdown of this specific child.
      server.kill('SIGINT');
      const watchdog = setTimeout(() => server.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(watchdog);
      }
    }
    rmSync(socketRoot, { recursive: true, force: true });
  });

  function run(name, args, input) {
    const command = bin(name);
    const result = spawnSync(command, args, { ...options, input });
    if (result.error) {
      throw new Error(`Could not run ${command}. Set PLANNER_TEST_PG_BIN_DIR to the PostgreSQL 17 tools.`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      throw new Error(`${name} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  function query(database, sql, user = 'fixture_reader') {
    return run('psql', [
      '-XqAtw', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
      '-h', socketRoot, '-p', port, '-U', user, '-d', database, '-f', '-',
    ], sql);
  }

  run('initdb', [
    '-D', data, '--username=fixture_owner', '--auth-local=trust', '--auth-host=reject',
    '--encoding=UTF8', '--locale=C', '--no-instructions',
  ]);
  server = spawn(bin('postgres'), [
    '-D', data,
    '-c', 'listen_addresses=',
    '-c', `unix_socket_directories=${socketRoot}`,
    '-c', 'unix_socket_permissions=0700',
    '-c', `port=${port}`,
  ], { env, cwd: socketRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  server.once('error', (error) => { serverError = error; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  closed = new Promise((resolve) => server.once('close', resolve));

  const socket = join(socketRoot, `.s.PGSQL.${port}`);
  const deadline = Date.now() + 10_000;
  while (!log.includes('database system is ready to accept connections')) {
    if (serverError || server.exitCode !== null || server.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`Private PostgreSQL did not start: ${log}`, { cause: serverError });
    }
    await delay(50);
  }
  if (!lstatSync(socket).isSocket() || (statSync(socketRoot).mode & 0o777) !== 0o700 ||
      (statSync(socket).mode & 0o777) !== 0o700) {
    throw new Error('Private PostgreSQL socket permissions do not match the fixture boundary');
  }

  const write = (database, sql) => query(database, sql, 'fixture_owner');
  const version = write('postgres', 'SHOW server_version_num;');
  if (!/^17[0-9]{4}$/.test(version)) {
    throw new Error(`The fixture catalog requires PostgreSQL 17 tools. Server version number: ${version}`);
  }
  write('postgres', 'CREATE ROLE fixture_reader LOGIN;');
  return { query, write };
}
