import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountEmailSchema, accountNameSchema, type FirstAdminInput } from '@planner/contracts';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import type { Db } from 'mongodb';
import type { CommandGate } from '../command-gate/gate.js';
import { commandUuid, CommandRecoveryError } from '../command-journal/operation.js';
import { assertChanged, durable } from '../command-journal/records.js';
import { applyCommandEffect } from '../../storage/command-effects.js';
import { isStoredDate, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema, type InstallationDocument } from '../../storage/schema.js';
import { accounts, defaultPreferences, type AccountRecord } from './accounts.js';
import { normalizeIdentifier, tokenDigest } from './credentials.js';
import { isPasswordVerifier, type PasswordHasher, type PasswordVerifier } from './password.js';

const grantLifetimeMs = 30 * 60_000;

interface FirstAdminClaim {
  accountId: string;
  name: string;
  email: string;
  passwordVerifier: PasswordVerifier;
}

interface Grant {
  _id: string;
  id: string;
  installationId: string;
  generationId: string;
  kind: 'first-admin';
  tokenDigest: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  firstAdminClaim?: FirstAdminClaim;
}

type Checkpoint = 'claimed' | 'account' | 'audited' | 'published';

export function firstAdminBinding(installation: InstallationDocument) {
  const { setup, activeGenerationId, installationId } = installation;
  if (setup?.mode !== 'fresh' || !generationIdSchema.safeParse(setup.enrollmentGenerationId).success
      || !isStoredDate(setup.firstAdminGrantIssuedAt)) return null;
  const generationId = setup.enrollmentGenerationId!;
  const published = activeGenerationId === generationId && setup.pendingAction === 'complete';
  if (!published && (activeGenerationId !== null || setup.pendingAction !== 'first-admin-enrollment')) return null;
  return { installationId, generationId, issuedAt: setup.firstAdminGrantIssuedAt, kind: 'first-admin' as const, published };
}

type Binding = NonNullable<ReturnType<typeof firstAdminBinding>>;
const grants = (database: Db) => database.collection<Grant>('recoveryGrants');
const grantFilter = ({ installationId, generationId, issuedAt, kind }: Binding) => ({ installationId, generationId, issuedAt, kind });

function verifyGrant(grant: Grant) {
  if (!publicIdSchema.safeParse(grant.id).success || grant._id !== workspaceKey(grant.generationId, grant.id)
      || !isStoredDate(grant.expiresAt) || grant.expiresAt.getTime() !== grant.issuedAt.getTime() + grantLifetimeMs) {
    throw new CommandRecoveryError('First-administrator enrollment has an invalid grant.');
  }
}

async function completeClaim(database: Db, binding: Binding, grant: Grant, checkpoint?: (point: Checkpoint) => void | Promise<void>) {
  verifyGrant(grant);
  const claim = grant.firstAdminClaim;
  const createdAt = grant.consumedAt;
  if (!claim || !generationIdSchema.safeParse(claim.accountId).success
      || !accountNameSchema.safeParse(claim.name).success || !accountEmailSchema.safeParse(claim.email).success
      || !isPasswordVerifier(claim.passwordVerifier) || !isStoredDate(createdAt)
      || createdAt < grant.issuedAt || createdAt >= grant.expiresAt) {
    throw new CommandRecoveryError('First-administrator enrollment has an invalid claim.');
  }
  const { installationId, generationId } = binding;
  const account: AccountRecord = {
    _id: workspaceKey(generationId, claim.accountId), id: claim.accountId, generationId, revision: 1,
    name: claim.name, email: claim.email, normalizedEmail: normalizeIdentifier(claim.email), username: null, normalizedUsername: null,
    role: 'admin', disabledAt: null, createdAt, preferences: defaultPreferences,
    localAuth: { passwordVerifier: claim.passwordVerifier, credentialsVersion: 1, mfa: 'none' },
  };
  const { _id, ...fields } = account;
  const stored = await accounts(database).findOneAndUpdate(
    { _id, generationId, id: account.id }, { $setOnInsert: fields }, { ...durable, upsert: true, returnDocument: 'after' },
  );
  if (!isDeepStrictEqual(stored, account)) throw new CommandRecoveryError('First-administrator enrollment conflicts with the stored account.');
  await checkpoint?.('account');

  const commandId = commandUuid(generationId, ['first-admin-enrollment', grant.id]);
  await applyCommandEffect(database, generationId, {
    kind: 'insert', collection: 'auditEntries', id: commandUuid(commandId, ['audit']),
    effectId: commandUuid(commandId, ['effect', '0']),
    fields: {
      actorId: account.id, origin: 'web', commandId, resourceId: account.id, resourceType: 'account',
      action: 'first-admin-enrollment', createdAt: createdAt.toISOString(),
    },
  }, false, async () => {});
  await checkpoint?.('audited');

  if (!binding.published) {
    const published = await database.collection<InstallationDocument>('installation').updateOne({
      _id: 'installation', installationId, activeGenerationId: { $type: 'null' },
      'setup.mode': 'fresh', 'setup.pendingAction': 'first-admin-enrollment',
      'setup.enrollmentGenerationId': generationId, 'setup.firstAdminGrantIssuedAt': binding.issuedAt,
    }, { $set: { activeGenerationId: generationId, 'setup.pendingAction': 'complete' } }, durable);
    assertChanged(published.matchedCount);
  }
  await checkpoint?.('published');

  const cleaned = await grants(database).updateOne({
    _id: grant._id, ...grantFilter(binding), consumedAt: createdAt, 'firstAdminClaim.accountId': claim.accountId,
  }, { $unset: { firstAdminClaim: '' } }, durable);
  assertChanged(cleaned.matchedCount);
}

// Runs within the startup gate after generic journal replay. The consumed grant is the bounded private intent.
export async function recoverFirstAdmin(database: Db, installationId: string) {
  const installation = await readInstallation(database, installationId);
  requireCurrentSchema(installation);
  const binding = firstAdminBinding(installation);
  if (!binding) return;
  const [claim, extra] = await grants(database).find({
    ...grantFilter(binding), firstAdminClaim: { $exists: true },
  }, { limit: 2 }).toArray();
  if (extra) throw new CommandRecoveryError('First-administrator enrollment has multiple claims.');
  if (claim) await completeClaim(database, binding, claim);
}

export async function hasFirstAdminGrant(database: Db, installation: InstallationDocument, now: Date) {
  const binding = firstAdminBinding(installation);
  if (!binding || binding.published) return false;
  const grant = await grants(database).findOne({
    ...grantFilter(binding), consumedAt: { $type: 'null' }, firstAdminClaim: { $exists: false }, expiresAt: { $gt: now },
  }, { projection: { tokenDigest: 0 } });
  if (!grant) return false;
  verifyGrant(grant);
  return true;
}

export function createFirstAdminEnrollment(
  database: Db,
  installationId: string,
  gate: CommandGate,
  hasher: PasswordHasher,
  now = () => new Date(),
  checkpoint?: (point: Checkpoint) => void | Promise<void>,
) {
  return async (input: FirstAdminInput) => {
    const digest = tokenDigest(input.grant);
    const filter = async () => {
      const installation = await readInstallation(database, installationId);
      requireCurrentSchema(installation);
      const binding = firstAdminBinding(installation);
      const current = now();
      return binding && !binding.published && current >= binding.issuedAt ? {
        binding, current, match: {
          ...grantFilter(binding), tokenDigest: digest, consumedAt: { $type: 'null' as const },
          firstAdminClaim: { $exists: false }, expiresAt: { $gt: current },
        },
      } : null;
    };
    const eligible = await gate.readSnapshot(async () => {
      const scope = await filter();
      return !!scope && !!await grants(database).findOne(scope.match, { projection: { _id: 1 } });
    });
    if (!eligible) return false;
    const claim: FirstAdminClaim = {
      accountId: randomUUID(), name: input.name, email: input.email, passwordVerifier: await hasher.encode(input.password),
    };

    return gate.runCommand(async () => {
      const scope = await filter();
      if (!scope) return false;
      const eligibleGrant = await grants(database).findOne(scope.match);
      if (!eligibleGrant) return false;
      verifyGrant(eligibleGrant);
      if (await accounts(database).findOne({ generationId: scope.binding.generationId }, { projection: { _id: 1 } })) {
        throw new CommandRecoveryError('First-administrator enrollment requires an empty generation.');
      }
      const grant = await grants(database).findOneAndUpdate({ ...scope.match, _id: eligibleGrant._id },
        { $set: { consumedAt: scope.current, firstAdminClaim: claim } }, { ...durable, returnDocument: 'after' });
      if (!grant) return false;
      await checkpoint?.('claimed');
      await completeClaim(database, scope.binding, grant, checkpoint);
      return true;
    });
  };
}
