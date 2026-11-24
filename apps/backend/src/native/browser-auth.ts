import type { KeyObject } from 'node:crypto';
import {
  accountRecoveryInputSchema, accountRecoveryOutputSchema, boardEventsPath, firstAdminInputSchema, firstAdminOutputSchema, loginInputSchema, loginOutputSchema, loginWithMfaOutputSchema, passiveSessionHeader, sessionSchema,
  workspaceSignInPath, type BrowserSession, type FirstAdminInput,
} from '@planner/contracts';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import type { BoardEventStreams } from '../application/board-events/streams.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import {
  clearSessionCookie, createLoginRateLimit, hasValidCsrf, normalizeIdentifier, readSessionCookie, sessionCookie,
} from '../application/auth/credentials.js';
import { createAccountCredentials, type AccountCredentials } from '../application/auth/account-credentials.js';
import { createAccountDirectory, type AccountDirectory } from '../application/auth/account-directory.js';
import { AccountActionError } from '../application/auth/account-policy.js';
import { createFirstAdminEnrollment } from '../application/auth/first-admin.js';
import { readTrustedDeviceCookie } from '../application/auth/mfa-cookie.js';
import { createMfaManagement } from '../application/auth/mfa-management.js';
import { createPasswordHasher, HashCapacityError } from '../application/auth/password.js';
import { createBrowserSessions, type BrowserSessions } from '../application/auth/sessions.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';
import { browserMfaVerifyPath, mfaEnrollmentPath, mfaEnrollmentVerifyPath, type NativeMfa } from './mfa-routes.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    plannerPassiveRead?: true;
  }
  interface FastifyRequest {
    plannerSession: BrowserSession | null;
  }
}

export type NativeAccountManagement = AccountDirectory & AccountCredentials;

export interface BrowserAuth extends Pick<BrowserSessions, 'login' | 'read' | 'revoke'> {
  accountManagement?: NativeAccountManagement;
  mfa?: NativeMfa;
  confirm: (input: FirstAdminInput) => Promise<boolean>;
}

export function createNativeBrowserAuth(
  config: NativeInstallationConfig, gate: CommandGate, mfaKey: KeyObject,
  streams?: Pick<BoardEventStreams, 'revalidateActor' | 'disconnectToken'>,
): BrowserAuth & { accountManagement: NativeAccountManagement; mfa: NativeMfa } {
  const hasher = createPasswordHasher();
  const allowFactorOwner = createLoginRateLimit();
  async function withDatabase<T>(operation: (database: Db) => Promise<T>) {
    const client = await connectConfiguredNativeMongo(config);
    try { return await operation(client.db(databaseName)); }
    finally { await client.close(); }
  }
  const sessions = (database: Db) => createBrowserSessions(database, config.installationId, gate, hasher, undefined, mfaKey);
  const factors = (database: Db) => createMfaManagement(database, config.installationId, gate, mfaKey, hasher, undefined, streams?.revalidateActor);

  const directory = (database: Db) => createAccountDirectory(database, config.installationId, gate, hasher);
  const credentials = (database: Db) => createAccountCredentials(database, config.installationId, gate, hasher, undefined, undefined, streams?.revalidateActor);

  return {
    mfa: {
      verify: (input, address) => withDatabase((database) => sessions(database).verifyMfa(input, (id) => allowFactorOwner(id, address))),
      manage: {
        begin: (...args) => withDatabase((database) => factors(database).begin(...args)),
        confirm: (...args) => withDatabase((database) => factors(database).confirm(...args)),
        renew: (...args) => withDatabase((database) => factors(database).renew(...args)),
        disable: (...args) => withDatabase((database) => factors(database).disable(...args)),
        list: (...args) => withDatabase((database) => factors(database).list(...args)),
        revoke: (...args) => withDatabase((database) => factors(database).revoke(...args)),
      },
    },
    accountManagement: {
      profile: (...args) => withDatabase((database) => directory(database).profile(...args)),
      preferences: (...args) => withDatabase((database) => directory(database).preferences(...args)),
      list: (...args) => withDatabase((database) => directory(database).list(...args)),
      updateProfile: (...args) => withDatabase((database) => directory(database).updateProfile(...args)),
      updatePreferences: (...args) => withDatabase((database) => directory(database).updatePreferences(...args)),
      provision: (...args) => withDatabase((database) => directory(database).provision(...args)),
      requestApproval: (...args) => withDatabase((database) => credentials(database).requestApproval(...args)),
      inspectApproval: (...args) => withDatabase((database) => credentials(database).inspectApproval(...args)),
      confirmApproval: (...args) => withDatabase((database) => credentials(database).confirmApproval(...args)),
      changePassword: (...args) => withDatabase((database) => credentials(database).changePassword(...args)),
      consumeRecovery: (...args) => withDatabase((database) => credentials(database).consumeRecovery(...args)),
    },
    confirm: (input) => withDatabase((database) => createFirstAdminEnrollment(database, config.installationId, gate, hasher)(input)),
    login: (...args) => withDatabase((database) => sessions(database).login(...args)),
    read: (token, activity) => withDatabase((database) => sessions(database).read(token, activity)),
    async revoke(token) {
      const revoked = await withDatabase((database) => sessions(database).revoke(token));
      if (revoked) streams?.disconnectToken(token);
      return revoked;
    },
  };
}

const recoverPath = '/api/v1/recovery/consume';
const loginPath = '/api/v1/session/login';
const sessionPath = '/api/v1/session';
const bodyLimit = 4096;

const errors = {
  badInput: [400, 'INVALID_REQUEST', 'Check the information you entered.'],
  grant: [400, 'INVALID_GRANT', 'The enrollment grant is invalid or has expired.'],
  credentials: [401, 'INVALID_CREDENTIALS', 'Incorrect identifier or password.'],
  session: [401, 'UNAUTHENTICATED', 'Sign in to continue.'],
  origin: [403, 'FORBIDDEN', 'This request is not allowed.'],
  limited: [429, 'RATE_LIMITED', 'Too many attempts. Try again later.'],
  unavailable: [503, 'UNAVAILABLE', 'Planner is unavailable.'],
} as const;

function authError(reply: FastifyReply, request: FastifyRequest, error: keyof typeof errors) {
  const [status, code, message] = errors[error];
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: { code, message, requestId: request.id } });
}

function isBrowserMutation(request: FastifyRequest) {
  return !!request.plannerConnection?.clientAddress && request.headers.origin === request.plannerConnection.origin;
}

function requestPath(request: FastifyRequest) {
  return (request.raw.url ?? '').split('?', 1)[0];
}

function isShellPage(pathname: string) {
  return /^\/(?:(?:workspace|inbox)\/?|settings(?:\/security)?\/?|admin\/accounts\/?|projects\/[^/]+\/?|boards\/[^/]+(?:\/cards\/[^/]+)?\/?)$/u.test(pathname);
}

function passiveRead(request: FastifyRequest) {
  return request.routeOptions.config.plannerPassiveRead === true || request.headers[passiveSessionHeader] === '1';
}

function isPublicBrowserRoute(method: string, pathname: string, mfa: boolean) {
  if (method === 'POST') return pathname === recoverPath || pathname === loginPath
    || (mfa && (pathname === browserMfaVerifyPath || pathname === mfaEnrollmentPath || pathname === mfaEnrollmentVerifyPath));
  if (pathname === sessionPath) return method === 'DELETE' || method === 'GET';
  return (method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/sign-in' || pathname === '/recover' || pathname === '/account-recovery');
}

export function registerNativeBrowserAuth(app: FastifyInstance, auth: BrowserAuth) {
  app.decorateRequest('plannerSession', null);
  const allowLogin = createLoginRateLimit();
  const allowEnrollment = createLoginRateLimit();

  app.addHook('onRequest', async (request, reply) => {
    // The transport boundary alone handles health, immutable assets, and the exact staged enrollment paths.
    if (request.plannerAccess?.kind !== 'ready') return;
    const pathname = requestPath(request);
    if (isPublicBrowserRoute(request.method, pathname, !!auth.mfa)) return;
    // The exact SSE handler validates a passive session under its own read lease.
    if (request.method === 'GET' && request.routeOptions.url === boardEventsPath
        && request.routeOptions.config.plannerPassiveSession) return;
    reply.header('Cache-Control', 'no-store');

    const read = request.method === 'GET' || request.method === 'HEAD';
    if (!read && !isBrowserMutation(request)) return authError(reply, request, 'origin');
    const token = readSessionCookie(request.headers.cookie);
    try {
      if (request.plannerConnection?.clientAddress && token) {
        if (!read && !hasValidCsrf(token, request.headers['x-csrf-token'])) return authError(reply, request, 'origin');
        request.plannerSession = await auth.read(token, read && passiveRead(request) ? 'passive' : 'active');
        if (request.plannerSession) return;
      }
    } catch { return authError(reply, request, 'unavailable'); }
    if (request.method === 'GET' && request.plannerConnection?.clientAddress && isShellPage(pathname)) {
      return reply.redirect(workspaceSignInPath(request.raw.url));
    }
    return authError(reply, request, 'session');
  });

  app.register(async (routes) => {
    routes.setErrorHandler((error: { statusCode?: number }, request, reply) => {
      if (error instanceof HashCapacityError) return authError(reply, request, 'limited');
      if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
        return authError(reply, request, 'badInput');
      }
      return authError(reply, request, 'unavailable');
    });
    routes.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });

    routes.post(recoverPath, { bodyLimit }, async (request, reply) => {
      if (!isBrowserMutation(request)) return authError(reply, request, 'origin');
      if (request.plannerAccess?.kind === 'ready' && auth.accountManagement) {
        const input = accountRecoveryInputSchema.safeParse(request.body);
        if (!input.success) return authError(reply, request, 'badInput');
        if (!allowEnrollment(input.data.grant, request.plannerConnection!.clientAddress!)) return authError(reply, request, 'limited');
        try { return accountRecoveryOutputSchema.parse(await auth.accountManagement.consumeRecovery(input.data)); }
        catch (error) {
          if (error instanceof AccountActionError && error.kind === 'grant') return authError(reply, request, 'grant');
          throw error;
        }
      }
      if (request.plannerAccess?.kind !== 'enrollment' || request.plannerAccess.step !== 'recovery') {
        return authError(reply, request, 'grant');
      }
      const input = firstAdminInputSchema.safeParse(request.body);
      if (!input.success) return authError(reply, request, 'badInput');
      if (!allowEnrollment(input.data.grant, request.plannerConnection!.clientAddress!)) return authError(reply, request, 'limited');
      if (!await auth.confirm(input.data)) return authError(reply, request, 'grant');
      return firstAdminOutputSchema.parse({ status: 'confirmed' });
    });

    routes.post(loginPath, { bodyLimit }, async (request, reply) => {
      if (!isBrowserMutation(request)) return authError(reply, request, 'origin');
      const input = loginInputSchema.safeParse(request.body);
      if (!input.success) return authError(reply, request, 'credentials');
      if (!allowLogin(normalizeIdentifier(input.data.identifier), request.plannerConnection!.clientAddress!)) {
        return authError(reply, request, 'limited');
      }
      const result = await auth.login(input.data, readTrustedDeviceCookie(request.headers.cookie));
      if (result.status === 'invalid') return authError(reply, request, 'credentials');
      if (result.status !== 'authenticated') {
        return auth.mfa ? loginWithMfaOutputSchema.parse(result) : loginOutputSchema.parse(result);
      }
      if (result.status === 'authenticated') {
        const session = loginOutputSchema.parse(result.session);
        reply.header('Set-Cookie', sessionCookie(result.token));
        return session;
      }
    });

    routes.get(sessionPath, { exposeHeadRoute: false }, async (request, reply) => {
      const token = readSessionCookie(request.headers.cookie);
      if (!request.plannerConnection?.clientAddress || !token) return authError(reply, request, 'session');
      const session = await auth.read(token, passiveRead(request) ? 'passive' : 'active');
      if (!session) return authError(reply, request, 'session');
      return sessionSchema.parse(session);
    });

    routes.delete(sessionPath, async (request, reply) => {
      if (!isBrowserMutation(request)) return authError(reply, request, 'origin');
      const token = readSessionCookie(request.headers.cookie);
      if (!token) return authError(reply, request, 'session');
      if (!hasValidCsrf(token, request.headers['x-csrf-token'])) return authError(reply, request, 'origin');
      const revoked = await auth.revoke(token);
      if (!revoked) return authError(reply, request, 'session');
      return reply.code(204).header('Set-Cookie', clearSessionCookie).send();
    });
  });
}
