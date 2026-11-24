import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import type { ClientConfig } from 'pg';
import { MigrationError } from './manifest.js';

export const migrationServiceName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;
const sqlName = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u;
const fields = new Set(['host', 'port', 'dbname', 'user', 'password', 'isolated']);
const versionSocket = '.s.PGSQL.';

function invalid() {
  return new MigrationError('source-service', 'Select a protected service for an isolated PostgreSQL restore.');
}

export function parseSourceService(config: string, name: string) {
  if (!migrationServiceName.test(name) || Buffer.byteLength(config) > 64 * 1024) throw invalid();
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const heading = /^\[([^\]]+)\]$/u.exec(line);
    if (heading) {
      if (!migrationServiceName.test(heading[1]) || sections.has(heading[1])) throw invalid();
      section = new Map();
      sections.set(heading[1], section);
      continue;
    }
    const equals = line.indexOf('=');
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!section || equals < 1 || !fields.has(key) || section.has(key) || !value || /[\p{Cc}]/u.test(value)) throw invalid();
    section.set(key, value);
  }
  const service = sections.get(name);
  if (!service || service.get('isolated') !== 'true') throw invalid();
  const host = service.get('host') ?? '';
  const database = service.get('dbname') ?? '';
  const user = service.get('user') ?? '';
  const portText = service.get('port') ?? '';
  const port = Number(portText);
  if (!isAbsolute(host) || normalize(host) !== host || host === '/' || !sqlName.test(database) || !sqlName.test(user)
    || !/^[1-9][0-9]{0,4}$/u.test(portText) || port > 65_535 || Buffer.byteLength(join(host, versionSocket + port)) > 103
    || database === 'postgres' || database === 'template0' || database === 'template1') throw invalid();
  const password = service.get('password') ?? '';
  return { host, port, user, database, password, ssl: false, application_name: 'planner-migration-preflight',
    client_encoding: 'UTF8', connectionTimeoutMillis: 8_000, query_timeout: 35_000 } satisfies ClientConfig;
}

export async function assertSourceSocket(service: ReturnType<typeof parseSourceService>) {
  let current = '/';
  try {
    for (const component of service.host.slice(1).split('/')) {
      current = join(current, component);
      const entry = await lstat(current);
      if (!entry.isDirectory() || (entry.mode & 0o022) !== 0) throw invalid();
    }
    const socket = await lstat(join(service.host, versionSocket + service.port));
    const directory = await lstat(service.host);
    if (!socket.isSocket() || socket.uid !== directory.uid || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0)
      throw invalid();
  } catch { throw invalid(); }
}
