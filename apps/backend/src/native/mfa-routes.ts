import {
  mfaEnrollmentInputSchema, mfaEnrollmentOutputSchema, mfaEnrollmentVerifyInputSchema, reauthenticateMfaInputSchema,
  recoveryCodesOutputSchema, sessionSchema, trustedDevicesOutputSchema, verifyMfaInputSchema,
  type BrowserSession, type VerifyMfaInput,
} from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  clearSessionCookie, createLoginRateLimit, hasValidCsrf, readSessionCookie, sessionCookie,
} from '../application/auth/credentials.js';
import { clearTrustedDeviceCookie, readTrustedDeviceCookie, trustedDeviceCookie } from '../application/auth/mfa-cookie.js';
import type { MfaManagement } from '../application/auth/mfa-management.js';
import { HashCapacityError } from '../application/auth/password.js';

export const mfaEnrollmentPath = '/api/v1/mfa/enrollment';
export const mfaEnrollmentVerifyPath = '/api/v1/mfa/enrollment/verify';
export const browserMfaVerifyPath = '/api/v1/session/verify-mfa';

export interface NativeMfa {
  verify(input: VerifyMfaInput, sourceAddress: string): Promise<{
    session: BrowserSession;
    token: string;
    trustedToken?: string;
  } | null>;
  manage: MfaManagement;
}

const errors = {
  badInput: [400, 'INVALID_REQUEST', 'Check the information you entered.'],
  factor: [401, 'INVALID_FACTOR', 'The code is invalid or this sign-in has expired.'],
  enrollment: [403, 'ENROLLMENT_UNAVAILABLE', 'This enrollment is unavailable. Sign in again or contact your operator.'],
  reauthentication: [403, 'REAUTHENTICATION_REQUIRED', 'Enter your current password and a valid code.'],
  session: [401, 'UNAUTHENTICATED', 'Sign in to continue.'],
  origin: [403, 'FORBIDDEN', 'This request is not allowed.'],
  missing: [404, 'DEVICE_NOT_FOUND', 'This trusted browser is unavailable.'],
  limited: [429, 'RATE_LIMITED', 'Too many attempts. Try again later.'],
  unavailable: [503, 'UNAVAILABLE', 'Planner is unavailable.'],
} as const;

function respond(reply: FastifyReply, request: FastifyRequest, error: keyof typeof errors) {
  const [status, code, message] = errors[error];
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: { code, message, requestId: request.id } });
}

function browserSource(request: FastifyRequest) {
  const connection = request.plannerConnection;
  return connection && request.headers.origin === connection.origin ? connection.clientAddress : null;
}

function csrfSession(request: FastifyRequest) {
  const token = readSessionCookie(request.headers.cookie);
  return token && hasValidCsrf(token, request.headers['x-csrf-token']) ? token : undefined;
}

const bodyLimit = 4096;

export function registerNativeMfaRoutes(app: FastifyInstance, mfa: NativeMfa) {
  const allowAttempt = createLoginRateLimit();

  app.register(async (routes) => {
    routes.setErrorHandler((error: { statusCode?: number }, request, reply) => {
      if (error instanceof HashCapacityError) return respond(reply, request, 'limited');
      return respond(reply, request, error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? 'badInput' : 'unavailable');
    });
    routes.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });

    routes.post(browserMfaVerifyPath, { bodyLimit }, async (request, reply) => {
      const source = browserSource(request);
      if (!source) return respond(reply, request, 'origin');
      const input = verifyMfaInputSchema.safeParse(request.body);
      if (!input.success) return respond(reply, request, 'badInput');
      if (!allowAttempt(input.data.challengeId, source)) return respond(reply, request, 'limited');
      const result = await mfa.verify(input.data, source);
      if (!result) return respond(reply, request, 'factor');
      const cookies = [sessionCookie(result.token)];
      if (result.trustedToken) cookies.push(trustedDeviceCookie(result.trustedToken));
      reply.header('Set-Cookie', cookies);
      return sessionSchema.parse(result.session);
    });

    routes.post(mfaEnrollmentPath, { bodyLimit }, async (request, reply) => {
      const source = browserSource(request);
      if (!source) return respond(reply, request, 'origin');
      const input = mfaEnrollmentInputSchema.safeParse(request.body);
      if (!input.success) return respond(reply, request, 'badInput');
      const sessionToken = csrfSession(request);
      const identifier = input.data.enrollmentId ?? sessionToken;
      if (!identifier) return respond(reply, request, 'enrollment');
      if (!allowAttempt(identifier, source)) return respond(reply, request, 'limited');
      const setup = await mfa.manage.begin({ enrollmentId: input.data.enrollmentId, sessionToken });
      if (!setup) return respond(reply, request, 'enrollment');
      return mfaEnrollmentOutputSchema.parse(setup);
    });

    routes.post(mfaEnrollmentVerifyPath, { bodyLimit }, async (request, reply) => {
      const source = browserSource(request);
      if (!source) return respond(reply, request, 'origin');
      const input = mfaEnrollmentVerifyInputSchema.safeParse(request.body);
      if (!input.success) return respond(reply, request, 'badInput');
      if (!allowAttempt(input.data.enrollmentId, source)) return respond(reply, request, 'limited');
      const sessionToken = csrfSession(request);
      const issued = await mfa.manage.confirm({ enrollmentId: input.data.enrollmentId, sessionToken }, input.data.totpCode);
      if (!issued) return respond(reply, request, 'enrollment');
      if (sessionToken) reply.header('Set-Cookie', [clearSessionCookie, clearTrustedDeviceCookie]);
      return recoveryCodesOutputSchema.parse(issued);
    });

    routes.post('/api/v1/me/mfa/recovery-codes', { bodyLimit }, async (request, reply) => {
      const source = browserSource(request);
      if (!source || !csrfSession(request)) return respond(reply, request, 'origin');
      const input = reauthenticateMfaInputSchema.safeParse(request.body);
      if (!input.success) return respond(reply, request, 'badInput');
      const session = request.plannerSession;
      if (!session) return respond(reply, request, 'session');
      if (!allowAttempt(session.account.id, source)) return respond(reply, request, 'limited');
      const renewal = await mfa.manage.renew(csrfSession(request)!, input.data);
      if (!renewal) return respond(reply, request, 'reauthentication');
      return recoveryCodesOutputSchema.parse(renewal);
    });

    routes.delete('/api/v1/me/mfa', { bodyLimit }, async (request, reply) => {
      const source = browserSource(request);
      const token = csrfSession(request);
      if (!source || !token) return respond(reply, request, 'origin');
      const input = reauthenticateMfaInputSchema.safeParse(request.body);
      if (!input.success) return respond(reply, request, 'badInput');
      const session = request.plannerSession;
      if (!session) return respond(reply, request, 'session');
      if (!allowAttempt(session.account.id, source)) return respond(reply, request, 'limited');
      if (!await mfa.manage.disable(token, input.data)) return respond(reply, request, 'reauthentication');
      return reply.code(204).header('Set-Cookie', [clearSessionCookie, clearTrustedDeviceCookie]).send();
    });

    routes.get('/api/v1/me/trusted-devices', { exposeHeadRoute: false }, async (request, reply) => {
      const token = readSessionCookie(request.headers.cookie);
      if (!request.plannerSession || !token) return respond(reply, request, 'session');
      const devices = await mfa.manage.list(token, readTrustedDeviceCookie(request.headers.cookie));
      if (!devices) return respond(reply, request, 'session');
      return trustedDevicesOutputSchema.parse(devices);
    });

    routes.delete<{ Params: { deviceId: string } }>('/api/v1/me/trusted-devices/:deviceId', async (request, reply) => {
      const token = csrfSession(request);
      if (!browserSource(request) || !token) return respond(reply, request, 'origin');
      if (!request.plannerSession) return respond(reply, request, 'session');
      const id = publicIdSchema.safeParse(request.params.deviceId);
      if (!id.success) return respond(reply, request, 'missing');
      const revoked = await mfa.manage.revoke(token, id.data, readTrustedDeviceCookie(request.headers.cookie));
      if (!revoked) return respond(reply, request, 'missing');
      if (revoked.current) reply.header('Set-Cookie', clearTrustedDeviceCookie);
      return reply.code(204).send();
    });
  });
}
