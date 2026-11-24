import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { releases } = JSON.parse(read('source-pins.json'));

export function assembleSnapshot(release) {
  if (!Object.hasOwn(releases, release)) {
    throw new Error(`Unsupported PLANKA fixture release: ${release}`);
  }
  return [
    'BEGIN;\n',
    read('schema.sql'),
    'COPY migration (name) FROM stdin;\n',
    read('migrations.txt'),
    '\\.\n',
    "UPDATE migration SET batch = 1, migration_time = '2026-10-10 10:11:12.123456+00';\n",
    'INSERT INTO migration_lock (is_locked) VALUES (0);\n',
    read(`${release}/identity.sql`),
    read('data.sql'),
    'COMMIT;\n',
  ].join('');
}

if (import.meta.main) {
  process.stdout.write(assembleSnapshot(process.argv[2]));
}
