import { MongoClient, MongoServerError } from 'mongodb';

export const databaseName = 'planner';
export const appUsername = 'planner-app';
const adminUsername = 'planner-bootstrap';
const appRole = { role: 'readWrite', db: databaseName };
const adminRole = { role: 'userAdminAnyDatabase', db: 'admin' };
const installationKey = 'installation';
const writeConcern = { w: 1, j: true };

export class NativeMongoError extends Error {}

export interface MongoCredentials {
  installationId: string;
  port: number;
  dbUid: number;
  dbGid: number;
  password: string;
}

export function validMongoPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 && port !== 27_017;
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const passwordPattern = /^[0-9a-f]{64}$/u;

export function parseMongoCredentials(value: unknown): MongoCredentials {
  const credentials = value as Partial<MongoCredentials> | null;
  if (!credentials || typeof credentials.installationId !== 'string' || !uuidPattern.test(credentials.installationId)
      || !validMongoPort(credentials.port) || typeof credentials.dbUid !== 'number'
      || !Number.isInteger(credentials.dbUid) || credentials.dbUid <= 0
      || typeof credentials.dbGid !== 'number' || !Number.isInteger(credentials.dbGid) || credentials.dbGid <= 0
      || typeof credentials.password !== 'string' || !passwordPattern.test(credentials.password)) {
    throw new NativeMongoError('The Planner database credential file is invalid.');
  }
  return {
    installationId: credentials.installationId,
    port: credentials.port,
    dbUid: credentials.dbUid,
    dbGid: credentials.dbGid,
    password: credentials.password,
  };
}

export function mongoClient(endpoint: string, database?: string, username?: string, password?: string) {
  return new MongoClient(`mongodb://${endpoint}/?directConnection=true`, {
    ...(database && username && password && {
      authSource: database, authMechanism: 'SCRAM-SHA-256', auth: { username, password },
    }),
    connectTimeoutMS: 2_000,
    serverSelectionTimeoutMS: 2_000,
    socketTimeoutMS: 2_000,
    maxPoolSize: 1,
  });
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 18;
}

function hasOneRole(roles: unknown, expected: { role: string; db: string }) {
  return Array.isArray(roles) && roles.length === 1
    && roles[0]?.role === expected.role && roles[0]?.db === expected.db;
}

async function assertAuthenticatedRole(client: MongoClient, user: string, role: { role: string; db: string }) {
  const { authInfo } = await client.db(role.db).command({ connectionStatus: 1 });
  if (authInfo?.authenticatedUsers?.length !== 1 || authInfo.authenticatedUsers[0].user !== user
      || authInfo.authenticatedUsers[0].db !== role.db || !hasOneRole(authInfo.authenticatedUserRoles, role)) {
    throw new NativeMongoError('The Planner database user has an unexpected role.');
  }
}

interface DatabaseUser {
  user?: string;
  db?: string;
  roles?: unknown;
  customData?: { installationId?: string };
}

function assertAppUser(user: DatabaseUser | undefined, installationId: string) {
  if (user?.user !== appUsername || user.db !== databaseName || !hasOneRole(user.roles, appRole)
      || user.customData?.installationId !== installationId) {
    throw new NativeMongoError('The Planner database user has an unexpected role or installation claim.');
  }
}

async function readAppUser(client: MongoClient) {
  const { users } = await client.db(databaseName).command({ usersInfo: appUsername });
  if (!Array.isArray(users) || users.length > 1) {
    throw new NativeMongoError('The Planner database account could not be verified.');
  }
  return users[0] as DatabaseUser | undefined;
}

function installationCollection(client: MongoClient) {
  return client.db(databaseName).collection<{ _id: string; installationId: string }>('installation');
}

export async function assertMongoIdentity(client: MongoClient, installationId: string) {
  await assertAuthenticatedRole(client, appUsername, appRole);
  assertAppUser(await readAppUser(client), installationId);
  const record = await installationCollection(client).findOne({ _id: installationKey });
  if (record?.installationId !== installationId) {
    throw new NativeMongoError('The Planner database installation UUID does not match.');
  }
}

async function canAuthenticate(client: MongoClient) {
  try {
    await client.connect();
    return true;
  } catch (error) {
    if (isAuthenticationFailure(error)) return false;
    throw error;
  }
}

export async function provisionMongoIdentity(
  socketPath: string,
  credentials: MongoCredentials,
  temporaryPassword: string,
  canCreateFirstAdmin: boolean,
  recordAdminAuthenticated: () => Promise<void>,
) {
  const endpoint = encodeURIComponent(socketPath);
  const admin = mongoClient(endpoint, 'admin', adminUsername, temporaryPassword);
  const app = mongoClient(endpoint, databaseName, appUsername, credentials.password);
  try {
    if (!await canAuthenticate(admin)) {
      if (await canAuthenticate(app)) {
        if (canCreateFirstAdmin) throw new NativeMongoError('Unexpected initialized Planner database.');
        // A crash after dropping the administrator leaves only the verified application account.
        await assertMongoIdentity(app, credentials.installationId);
        return;
      }
      if (!canCreateFirstAdmin) throw new NativeMongoError('The pending Planner database credentials were refused.');

      const local = mongoClient(endpoint);
      try {
        await local.db('admin').command({
          createUser: adminUsername, pwd: temporaryPassword, roles: [adminRole],
          mechanisms: ['SCRAM-SHA-256'], writeConcern,
        });
      } finally {
        await local.close();
      }
      await admin.connect();
    }

    await assertAuthenticatedRole(admin, adminUsername, adminRole);
    await recordAdminAuthenticated();
    const appUser = await readAppUser(admin);
    if (appUser) {
      assertAppUser(appUser, credentials.installationId);
    } else {
      await admin.db(databaseName).command({
        createUser: appUsername, pwd: credentials.password, roles: [appRole],
        customData: { installationId: credentials.installationId },
        mechanisms: ['SCRAM-SHA-256'], writeConcern,
      });
    }

    await assertAuthenticatedRole(app, appUsername, appRole);
    const installation = installationCollection(app);
    const record = await installation.findOne({ _id: installationKey });
    if (!record) await installation.insertOne({
      _id: installationKey, installationId: credentials.installationId,
    }, { writeConcern });
    await assertMongoIdentity(app, credentials.installationId);
    await admin.db('admin').command({ dropUser: adminUsername, writeConcern });

    const retired = mongoClient(endpoint, 'admin', adminUsername, temporaryPassword);
    try {
      if (await canAuthenticate(retired)) throw new NativeMongoError('The temporary database administrator remained active.');
    } finally {
      await retired.close();
    }
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}
