const mongoEnvironment = /(?:^|_)MONGO(?:DB)?_(?:URI|URL|HOST|PORT|SOCKET|SOCKET_PATH|CONNECTION_STRING|CONFIG|OPTIONS|DBPATH)$/iu;
const genericDatabaseEnvironment = /^(?:PLANNER_)?(?:DATABASE|DB)_(?:URI|URL|CONNECTION_STRING)$/iu;
const mongoUri = /^\s*mongodb(?:\+srv)?:\/\//iu;

export function assertOwnedMongoEnvironment(env: NodeJS.ProcessEnv, args: readonly string[] = []) {
  const configured = Object.entries(env).some(([key, value]) => value !== undefined && (
    mongoEnvironment.test(key) || (genericDatabaseEnvironment.test(key) && mongoUri.test(value))
  ));
  if (args.length || configured) {
    throw new Error('The test runner only uses its own MongoDB fixture. Remove external MongoDB settings and arguments.');
  }
}
