import { createHash } from 'node:crypto';
import { CleanCommandRejection } from '../command-gate/gate.js';
import type { WorkspaceCollection } from '../../storage/catalog.js';
import { nameBasedUuid } from '../../storage/identity.js';
import type { openActiveWorkspace } from '../../storage/scoped.js';

export type JournalValue = null | boolean | number | string | JournalValue[] | { [key: string]: JournalValue };
export type JournalFields = Record<string, JournalValue>;
export type PlannedEffect =
  | { kind: 'insert'; collection: WorkspaceCollection; id: string; fields: JournalFields }
  | { kind: 'update'; collection: WorkspaceCollection; id: string; revision: number; fields: JournalFields }
  | { kind: 'delete'; collection: WorkspaceCollection; id: string; revision: number | null };

export interface CommandPlan {
  effects: readonly PlannedEffect[];
  result: JournalValue;
  audit: { resourceType: string; resourceId: string; action: string; detail?: JournalValue; origin?: 'web' | 'mcp' | 'operator' | 'system' };
  events?: readonly { boardId: string; kind: string; payload: JournalValue }[];
}

type Workspace = Awaited<ReturnType<typeof openActiveWorkspace>>;
export interface CommandContext {
  generationId: string;
  actorId: string;
  read: Workspace['read'];
}

export interface CommandPlanningContext extends CommandContext {
  commandId: string;
  timestamp: string;
}

export interface JournalOperation {
  // Return only journal-safe normalized semantics, including submitted revision preconditions.
  normalize(input: unknown): JournalValue;
  // Check current actor and resource access. Original revision checks belong in plan.
  authorize(context: CommandContext, request: JournalValue): void | Promise<void>;
  // Build deterministic declarative effects. Secrets use their dedicated storage operations.
  plan(context: CommandPlanningContext, request: JournalValue): CommandPlan | Promise<CommandPlan>;
}

export class CommandConflict extends CleanCommandRejection {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;
  constructor() { super('The idempotency key already belongs to a different request.'); }
}

export class CommandInputError extends CleanCommandRejection {}
export class CommandRecoveryError extends Error {}

const operationName = /^[a-z][a-zA-Z0-9_.-]{0,127}$/u;
export function isCommandName(value: unknown): value is string {
  return typeof value === 'string' && operationName.test(value);
}

export function commandOperations(operations: Readonly<Record<string, JournalOperation>>) {
  const registry = new Map(Object.entries(operations));
  for (const [name, operation] of registry) {
    if (!isCommandName(name)) throw new TypeError('Invalid command operation name.');
    registry.set(name, Object.freeze({ ...operation }));
  }
  return (name: string) => {
    const operation = registry.get(name);
    if (!operation) throw new CommandInputError('Unknown command operation.');
    return operation;
  };
}

function canonical(value: unknown, ancestors: Set<object>): JournalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value) || ancestors.size >= 64) {
    throw new TypeError('Expected bounded JSON-compatible journal data.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (item) => canonical(item, ancestors));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Expected plain JSON-compatible journal data.');
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      const field = key.toLowerCase().replace(/[^a-z]/gu, '');
      if (['proto', 'constructor', 'prototype', 'authorization', 'cookie'].includes(field)
          || /password|secret|credential|token|privatekey|recoverycode/u.test(field)) {
        throw new TypeError('Journal data contains a prohibited field.');
      }
      return [key, canonical((value as Record<string, unknown>)[key], ancestors)];
    }));
  } finally { ancestors.delete(value); }
}

export function canonicalJournalData(value: unknown) {
  return JSON.stringify(canonical(value, new Set()));
}

export function journalDigest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Standard name-based UUID, with structured names to preserve component boundaries.
export function commandUuid(namespace: string, names: readonly string[]) {
  return nameBasedUuid(namespace, JSON.stringify(names));
}
