import {
  accountAccessChangeSchema, accountDirectoryQuerySchema, accountApprovalSchema, accountPreferencesSchema,
  accountProfileSchema, accountProvisionSchema, accountRevisionSchema, adminAccountSchema, passwordChangeSchema,
  preferencesUpdateSchema, profileUpdateSchema,
} from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accountErrors, AccountActionError } from '../application/auth/account-policy.js';
import { clearSessionCookie, createLoginRateLimit, readSessionCookie } from '../application/auth/credentials.js';
import { HashCapacityError } from '../application/auth/password.js';
import { CommandConflict } from '../application/command-journal/operation.js';
import type { NativeAccountManagement } from './browser-auth.js';

const bodyLimit = 4096;

function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

function session(request: FastifyRequest) {
  const token = readSessionCookie(request.headers.cookie);
  const actorId = request.plannerSession?.account.id;
  if (!token || !actorId) throw new AccountActionError('session');
  return [token, actorId] as const;
}

class InvalidAccountRequest extends Error {}
function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } }, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidAccountRequest();
  return parsed.data;
}

export function registerAccountRoutes(app: FastifyInstance, accounts: NativeAccountManagement) {
  const allowReauthentication = createLoginRateLimit();
  app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    routes.setErrorHandler((error: { statusCode?: number }, request, reply) => {
      if (error instanceof AccountActionError) {
        const [status, code, message] = accountErrors[error.kind];
        return fail(reply, request, status, code, message);
      }
      if (error instanceof HashCapacityError) return fail(reply, request, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
      if (error instanceof CommandConflict) return fail(reply, request, error.statusCode, error.code, error.message);
      if (error instanceof InvalidAccountRequest || (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)) {
        return fail(reply, request, 400, 'INVALID_REQUEST', 'Check the information you entered.');
      }
      return fail(reply, request, 503, 'UNAVAILABLE', 'Planner is unavailable.');
    });
    function reauthenticate(request: FastifyRequest, reply: FastifyReply, actorId: string) {
      if (allowReauthentication(actorId, request.plannerConnection!.clientAddress!)) return true;
      fail(reply, request, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
      return false;
    }
    function key(request: FastifyRequest) {
      return parse(publicIdSchema, request.headers['idempotency-key']);
    }

    routes.get('/api/v1/me/profile', async (request) => accounts.profile(...session(request)));
    routes.get('/api/v1/me/preferences', async (request) => accounts.preferences(...session(request)));
    routes.patch('/api/v1/me/profile', { bodyLimit }, async (request, reply) => {
      const current = session(request);
      const input = parse(profileUpdateSchema, request.body);
      if (('email' in input || 'username' in input) && !reauthenticate(request, reply, current[1])) return;
      return accountProfileSchema.parse(await accounts.updateProfile(...current, key(request), input));
    });
    routes.patch('/api/v1/me/preferences', { bodyLimit }, async (request) => accountPreferencesSchema.parse(
      await accounts.updatePreferences(...session(request), key(request), parse(preferencesUpdateSchema, request.body)),
    ));
    routes.post('/api/v1/me/password', { bodyLimit }, async (request, reply) => {
      const current = session(request);
      if (!reauthenticate(request, reply, current[1])) return;
      await accounts.changePassword(...current, parse(passwordChangeSchema, request.body));
      return reply.code(204).header('Set-Cookie', clearSessionCookie).send();
    });

    routes.get('/api/v1/admin/accounts', async (request) =>
      accounts.list(...session(request), parse(accountDirectoryQuerySchema, request.query)));
    routes.post('/api/v1/admin/accounts', { bodyLimit }, async (request, reply) => {
      const created = adminAccountSchema.parse(await accounts.provision(
        ...session(request), key(request), parse(accountProvisionSchema, request.body),
      ));
      return reply.code(201).send(created);
    });
    routes.patch<{ Params: { id: string } }>('/api/v1/admin/accounts/:id', { bodyLimit }, async (request, reply) => {
      const { revision, ...change } = parse(accountAccessChangeSchema, request.body);
      const approval = await accounts.requestApproval(...session(request), parse(publicIdSchema, request.params.id), revision, change);
      return reply.code(202).send(accountApprovalSchema.parse(approval));
    });
    routes.post<{ Params: { id: string } }>('/api/v1/admin/accounts/:id/recovery', { bodyLimit }, async (request, reply) => {
      const { revision } = parse(accountRevisionSchema, request.body);
      const approval = await accounts.requestApproval(
        ...session(request), parse(publicIdSchema, request.params.id), revision, { action: 'recovery' },
      );
      return reply.code(202).send(accountApprovalSchema.parse(approval));
    });
  });
}
