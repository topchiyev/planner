import { isDeepStrictEqual } from 'node:util';
import { generationIdSchema, publicIdSchema } from '@planner/contracts/storage';
import { Long, type Db } from 'mongodb';
import { applyCommandEffect } from '../../storage/command-effects.js';
import { decodeRank, encodeRank, workspaceKey } from '../../storage/identity.js';
import { readInstallation, requireCurrentSchema, verifyStorageSchema } from '../../storage/schema.js';
import { openActiveWorkspace, openTrustedStagedWorkspace, workspaceInsertFields } from '../../storage/scoped.js';
import { CleanCommandRejection, GateUnavailableError, type CommandGate } from '../command-gate/gate.js';
import {
  canonicalJournalData, CommandConflict, CommandInputError, CommandRecoveryError, commandOperations, commandUuid,
  isCommandName, journalDigest, type CommandContext, type CommandPlan, type JournalOperation, type JournalValue,
  type PlannedEffect,
} from './operation.js';
import {
  assertChanged, batches, checkCommand, checkOutboxCursor, commands, durable, packBatches, readBatches, readJournalResult,
  validateEffect, type CommandRecord,
} from './records.js';

type Checkpoint = 'beforeIntent' | 'building' | 'batchStored' | 'prepared' | 'deleteReserved' | 'effectApplied'
  | 'committed' | 'beforeDelivery' | 'afterDelivery';

interface EventRecord {
  _id: string;
  id: string;
  generationId: string;
  commandId: string;
  boardId: string;
  sequence: Long;
  ordinal: number;
}

export interface OutboxSignal {
  id: string;
  generationId: string;
  boardId: string;
  sequence: string;
}

interface JournalOptions {
  operations?: Readonly<Record<string, JournalOperation>>;
  // Only process composition can bind the verified enrollment generation. Input never supplies a generation.
  scope?: 'active' | 'enrollment';
  checkpoint?: (point: Checkpoint, index?: number) => void | Promise<void>;
  // Synchronously enqueue the trusted signal. Any receipt settles outside the gate.
  // Recipient authorization and transport work are implemented by the subscriber.
  publish?: (signal: OutboxSignal) => void | Promise<void>;
}

type Workspace = Awaited<ReturnType<typeof openActiveWorkspace>>;

async function withReadContext<T>(
  workspace: Workspace, actorId: string, operation: (context: CommandContext) => T | Promise<T>,
) {
  let open = true;
  const pending: Promise<unknown>[] = [];
  let completed = false;
  let failure: unknown;
  try {
    const result = await operation(Object.freeze({
      generationId: workspace.generationId, actorId,
      read(...args: Parameters<Workspace['read']>) {
        if (!open) return Promise.reject(new Error('The command snapshot has ended.'));
        const request = workspace.read(...args);
        pending.push(request);
        void request.catch(() => {});
        return request;
      },
    }));
    completed = true;
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    open = false;
    const outcomes = await Promise.allSettled(pending);
    const first = outcomes.find((outcome) => outcome.status === 'rejected');
    if (first?.status === 'rejected' && (completed || failure instanceof CleanCommandRejection)) throw first.reason;
  }
}

function scopeGeneration(installation: Awaited<ReturnType<typeof readInstallation>>, scope: 'active' | 'enrollment') {
  if (scope === 'active') return installation.activeGenerationId;
  if (installation.activeGenerationId !== null) return null;
  const enrollment = generationIdSchema.safeParse(installation.setup?.enrollmentGenerationId);
  return enrollment.success ? enrollment.data : null;
}

export class CommandJournal {
  readonly #operations;
  #delivery?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #closed = false;

  constructor(
    readonly gate: CommandGate,
    readonly database: Db,
    readonly installationId: string,
    private readonly options: JournalOptions = {},
  ) {
    this.options = Object.freeze({ ...options });
    this.#operations = commandOperations(options.operations ?? {});
  }

  async execute(request: { actorId: string; operationId: string; idempotencyKey: string; input: unknown }): Promise<JournalValue> {
    const result = await this.gate.runCommand(async () => {
      const { operationId, actorId, idempotencyKey } = request;
      const operation = this.#operations(operationId);
      if (!publicIdSchema.safeParse(actorId).success || !publicIdSchema.safeParse(idempotencyKey).success) {
        throw new CommandInputError('Invalid command actor or idempotency key.');
      }
      let normalized: JournalValue;
      let hash: string;
      try {
        const semantic = canonicalJournalData(operation.normalize(request.input));
        normalized = JSON.parse(semantic);
        hash = journalDigest(semantic);
      } catch {
        throw new CommandInputError('Invalid command input.');
      }
      const workspace = await this.#workspace();
      const generationId = workspace.generationId;
      await withReadContext(workspace, actorId, (context) => operation.authorize(context, normalized));

      const collection = commands(this.database);
      const identity = { generationId, actorId, operationId, idempotencyKey };
      let command = await collection.findOne(identity, { promoteLongs: false });
      if (command) {
        checkCommand(command);
        if (command.requestHash !== hash) throw new CommandConflict();
        if (command.status === 'committed') return readJournalResult(command);
        if (command.status === 'prepared') return this.#finish(command);
      } else {
        const id = commandUuid(generationId, ['command', actorId, operationId, idempotencyKey]);
        command = { ...identity, _id: workspaceKey(generationId, id), id, status: 'building',
          requestHash: hash, createdAt: new Date() };
        await this.options.checkpoint?.('beforeIntent');
        await collection.insertOne(command, durable);
        await this.options.checkpoint?.('building');
      }

      const intent = command;
      const plan = await withReadContext(workspace, actorId, (context) => operation.plan(Object.freeze({
        ...context, commandId: intent.id, timestamp: intent.createdAt.toISOString(),
      }), normalized));
      const prepared = await this.#prepare(command, plan);
      await this.options.checkpoint?.('prepared');
      return this.#finish(prepared);
    });
    this.#wake();
    return result;
  }

  async recover(recoverPrivate?: () => void | Promise<void>) {
    await this.gate.recover(async () => {
      const installation = await verifyStorageSchema(this.database, this.installationId);
      const generationId = scopeGeneration(installation, 'active') ?? scopeGeneration(installation, 'enrollment');
      if (generationId) await this.#recoverScope(generationId);
      // Protected claims may have their own replay mechanism. This hook runs before admission.
      await recoverPrivate?.();
    });
    this.#wake();
  }

  async #recoverScope(generationId: string) {
    const collection = commands(this.database);
    const pending = collection.find({ generationId, status: { $ne: 'committed' } }, { promoteLongs: false })
      .sort({ recoverySequence: 1, id: 1 });
    for await (const command of pending) {
      checkCommand(command);
      if (command.status === 'building') continue; // Only an authorized retry can rebuild.
      await this.#finish(command);
    }
    const outbox = collection.find({ generationId, status: 'committed' }, {
      projection: { _id: 1, id: 1, delivered: 1, lastDeliveredEventId: 1, eventCount: 1, outboxPending: 1 },
    });
    for await (const cursor of outbox) {
      checkOutboxCursor(cursor);
      if (cursor.outboxPending) {
        const command = await collection.findOne({ generationId, _id: cursor._id }, { promoteLongs: false });
        if (!command) throw new CommandRecoveryError('A pending outbox command is missing.');
        await this.#verifyOutbox(command);
      }
    }
  }

  deliverPending(publish: (signal: OutboxSignal) => void | Promise<void>) {
    if (!this.#delivery) {
      this.#delivery = this.#deliver(publish).finally(() => { this.#delivery = undefined; });
    }
    return this.#delivery;
  }

  stopDelivery() {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  async #workspace() {
    const installation = await readInstallation(this.database, this.installationId);
    requireCurrentSchema(installation);
    if (this.options.scope !== 'enrollment') {
      if (!installation.activeGenerationId) throw new CommandInputError('No active generation is available.');
      return openActiveWorkspace(this.database, this.installationId);
    }
    const generation = scopeGeneration(installation, 'enrollment');
    if (!generation) throw new CommandInputError('No enrollment generation is available.');
    return openTrustedStagedWorkspace(this.database, this.installationId, generation);
  }

  #events() { return this.database.collection<EventRecord>('events'); }

  async #prepare(command: CommandRecord, plan: CommandPlan) {
    const result = canonicalJournalData(plan.result);
    const effects = [...plan.effects];
    effects.forEach((effect) => validateEffect(effect, false));
    if (!isCommandName(plan.audit.resourceType) || !isCommandName(plan.audit.action)
        || !publicIdSchema.safeParse(plan.audit.resourceId).success) throw new CommandRecoveryError('Invalid command audit entry.');
    effects.push({ kind: 'insert', collection: 'auditEntries', id: commandUuid(command.id, ['audit']), fields: {
      actorId: command.actorId, commandId: command.id, resourceType: plan.audit.resourceType,
      resourceId: plan.audit.resourceId, action: plan.audit.action, createdAt: command.createdAt.toISOString(),
      ...(plan.audit.origin && { origin: plan.audit.origin }),
      ...(plan.audit.detail === undefined ? {} : { detail: plan.audit.detail }),
    } });
    const sequences = new Map<string, bigint>();
    for (const [ordinal, event] of (plan.events ?? []).entries()) {
      if (this.options.scope === 'enrollment' || !publicIdSchema.safeParse(event.boardId).success || !isCommandName(event.kind)) {
        throw new CommandRecoveryError('Invalid command event.');
      }
      let last = sequences.get(event.boardId);
      if (last === undefined) {
        const newest = await this.#events().findOne({ generationId: command.generationId, boardId: event.boardId },
          { sort: { sequence: -1 }, promoteLongs: false });
        last = newest ? decodeRank(newest.sequence) : 0n;
      }
      const sequence = last + 1n;
      sequences.set(event.boardId, sequence);
      effects.push({ kind: 'insert', collection: 'events', id: commandUuid(command.id, ['event', String(ordinal)]), fields: {
        boardId: event.boardId, sequence: sequence.toString(), kind: event.kind, payload: event.payload,
        commandId: command.id, ordinal, createdAt: command.createdAt.toISOString(),
      } });
    }
    const { records, manifest } = packBatches(command, effects);
    const eventCount = plan.events?.length ?? 0;
    const latest = await Promise.all((['prepared', 'committed'] as const).map((status) =>
      commands(this.database).findOne({ generationId: command.generationId, status },
        { sort: { recoverySequence: -1 }, promoteLongs: false })));
    const last = latest.reduce((maximum, record) => {
      if (!record) return maximum;
      checkCommand(record);
      const sequence = decodeRank(record.recoverySequence!);
      return sequence > maximum ? sequence : maximum;
    }, 0n);
    const recoverySequence = encodeRank(last + 1n);
    const preparedFields = { status: 'prepared', recoverySequence, applied: 0, lastAppliedEffectId: null, manifest, result, resultHash: journalDigest(result),
      eventCount, delivered: 0, lastDeliveredEventId: null, outboxPending: eventCount > 0 } as const;
    const prepared = { ...command, ...preparedFields };
    const collection = batches(this.database);
    await collection.deleteMany({ generationId: command.generationId, commandId: command.id }, durable);
    for (const batch of records) {
      await collection.insertOne(batch, durable);
      await this.options.checkpoint?.('batchStored', batch.batch);
    }
    await this.#validateReplay(prepared);
    const written = await commands(this.database).updateOne({ _id: command._id, status: 'building' },
      { $set: preparedFields }, durable);
    assertChanged(written.matchedCount);
    return prepared;
  }

  async #validateReplay(command: CommandRecord) {
    checkCommand(command);
    const cursor = command.applied!;
    let index = 0;
    let audit = false;
    let events = 0;
    for await (const batch of readBatches(this.database, command)) {
      for (const effect of batch) {
        if (effect.collection === 'auditEntries') {
          if (audit || effect.kind !== 'insert' || effect.id !== commandUuid(command.id, ['audit'])
              || effect.fields.commandId !== command.id || effect.fields.actorId !== command.actorId
              || effect.fields.createdAt !== command.createdAt.toISOString()
              || !isCommandName(effect.fields.resourceType) || !isCommandName(effect.fields.action)
              || !publicIdSchema.safeParse(effect.fields.resourceId).success) {
            throw new CommandRecoveryError('A command audit effect has an invalid identity.');
          }
          audit = true;
        } else if (effect.collection === 'events') {
          if (!audit || effect.kind !== 'insert' || effect.id !== commandUuid(command.id, ['event', String(events)])
              || effect.fields.commandId !== command.id || effect.fields.ordinal !== events
              || effect.fields.createdAt !== command.createdAt.toISOString() || !isCommandName(effect.fields.kind)
              || !publicIdSchema.safeParse(effect.fields.boardId).success
              || typeof effect.fields.sequence !== 'string' || decodeRank(encodeRank(effect.fields.sequence)) <= 0n) {
            throw new CommandRecoveryError('A command event effect has an invalid identity.');
          }
          events += 1;
        } else if (audit) {
          throw new CommandRecoveryError('A domain effect follows its command audit.');
        }
        if (index === cursor - 1 && effect.effectId !== command.lastAppliedEffectId) {
          throw new CommandRecoveryError('A command journal cursor does not match the stored effect.');
        }
        if (index === cursor && command.pendingDelete !== undefined
            && (effect.kind !== 'delete' || command.pendingDelete !== effect.effectId)) {
          throw new CommandRecoveryError('The command deletion reservation is invalid.');
        }
        index += 1;
      }
    }
    if (cursor === index && command.pendingDelete !== undefined) throw new CommandRecoveryError('A command has an extra deletion reservation.');
    if (!audit || events !== command.eventCount) throw new CommandRecoveryError('A command audit or event manifest is incomplete.');
  }

  async #finish(command: CommandRecord): Promise<JournalValue> {
    await this.#validateReplay(command);
    const cursor = command.applied!;
    const collection = commands(this.database);
    let index = 0;
    let lastAppliedEffectId = command.lastAppliedEffectId ?? null;
    for await (const batch of readBatches(this.database, command)) {
      for (const effect of batch) {
        const step = index++;
        if (step < cursor) continue;
        const position = { _id: command._id, status: 'prepared', applied: step, lastAppliedEffectId } as const;
        await applyCommandEffect(this.database, command.generationId, effect, step === cursor && command.pendingDelete !== undefined,
          async () => {
            const reserved = await collection.updateOne({ ...position, pendingDelete: { $exists: false } },
              { $set: { pendingDelete: effect.effectId } }, durable);
            assertChanged(reserved.matchedCount);
            await this.options.checkpoint?.('deleteReserved', step);
          });
        await this.options.checkpoint?.('effectApplied', step);
        const advanced = await collection.updateOne(position, { $inc: { applied: 1 }, $set: { lastAppliedEffectId: effect.effectId }, $unset: { pendingDelete: '' } }, durable);
        assertChanged(advanced.matchedCount);
        lastAppliedEffectId = effect.effectId;
      }
    }
    const committed = await collection.updateOne({ _id: command._id, status: 'prepared', applied: index, lastAppliedEffectId, pendingDelete: { $exists: false } },
      { $set: { status: 'committed', committedAt: new Date() } }, durable);
    assertChanged(committed.matchedCount);
    await this.options.checkpoint?.('committed');
    return readJournalResult(command);
  }

  async #verifyOutbox(command: CommandRecord, firstOnly = false) {
    checkCommand(command);
    if (command.status !== 'committed') throw new CommandRecoveryError('An outbox command is uncommitted.');
    let ordinal = 0;
    for await (const batch of readBatches(this.database, command)) {
      for (const effect of batch) {
        if (effect.collection !== 'events' || effect.kind !== 'insert') continue;
        const eventOrdinal = ordinal++;
        if (eventOrdinal < command.delivered!) continue;
        const target = { _id: workspaceKey(command.generationId, effect.id), id: effect.id, generationId: command.generationId };
        const expected = { ...workspaceInsertFields('events', effect.fields), ...target, commandEffectId: effect.effectId };
        const event = await this.#events().findOne(target, { promoteLongs: false });
        if (!event || !isDeepStrictEqual(event, expected) || event.commandId !== command.id || event.ordinal !== eventOrdinal
            || event.id !== commandUuid(command.id, ['event', String(eventOrdinal)])
            || !publicIdSchema.safeParse(event.boardId).success || !Long.isLong(event.sequence) || decodeRank(event.sequence) <= 0n) {
          throw new CommandRecoveryError('A durable outbox event is missing or has changed.');
        }
        if (firstOnly) return event;
      }
    }
    if (ordinal !== command.eventCount || firstOnly) throw new CommandRecoveryError('The command outbox manifest is incomplete.');
    return null;
  }

  async #deliver(publish: (signal: OutboxSignal) => void | Promise<void>) {
    while (!this.#closed) {
      const delivery = await this.gate.readSnapshot(async () => {
        const installation = await readInstallation(this.database, this.installationId);
        requireCurrentSchema(installation);
        if (!installation.activeGenerationId) return null;
        const command = await commands(this.database).findOne({
          generationId: installation.activeGenerationId, status: 'committed', outboxPending: true,
        }, { sort: { recoverySequence: 1 }, promoteLongs: false });
        if (!command) return null;
        const event = await this.#verifyOutbox(command, true);
        if (!event) throw new CommandRecoveryError('The pending outbox has no event.');
        return { command, event };
      });
      if (!delivery) return;
      const { command, event } = delivery;
      await this.options.checkpoint?.('beforeDelivery');
      const handoff = await this.gate.readSnapshot(async () => {
        const installation = await readInstallation(this.database, this.installationId);
        requireCurrentSchema(installation);
        if (installation.activeGenerationId !== event.generationId) return null;
        const current = await commands(this.database).findOne({ _id: command._id, generationId: event.generationId, status: 'committed' },
          { projection: { id: 1, delivered: 1, lastDeliveredEventId: 1, eventCount: 1, outboxPending: 1 } });
        if (!current) throw new CommandRecoveryError('A pending outbox command is missing.');
        checkOutboxCursor(current);
        if (current.delivered! > event.ordinal) return null;
        if (current.delivered !== event.ordinal || current.eventCount !== command.eventCount || !current.outboxPending) {
          throw new CommandRecoveryError('The selected outbox event changed before handoff.');
        }
        if (!this.gate.ready) throw new GateUnavailableError();
        let receipt: Promise<void>;
        try {
          receipt = Promise.resolve(publish(Object.freeze({ id: event.id, generationId: event.generationId,
            boardId: event.boardId, sequence: decodeRank(event.sequence).toString() })));
        } catch (error) { receipt = Promise.reject(error); }
        void receipt.catch(() => {});
        return { receipt };
      });
      if (!handoff) continue;
      await handoff.receipt;
      await this.options.checkpoint?.('afterDelivery');
      await this.gate.runCommand(async () => {
        const installation = await readInstallation(this.database, this.installationId);
        requireCurrentSchema(installation);
        if (installation.activeGenerationId !== event.generationId) return;
        const delivered = event.ordinal + 1;
        const collection = commands(this.database);
        const acknowledged = await collection.updateOne({
          _id: command._id, generationId: event.generationId, status: 'committed', delivered: event.ordinal, outboxPending: true,
          lastDeliveredEventId: command.lastDeliveredEventId,
        }, { $set: { delivered, lastDeliveredEventId: event.id, outboxPending: delivered < command.eventCount! } }, durable);
        if (acknowledged.matchedCount === 0) {
          const current = await collection.findOne({ _id: command._id, generationId: event.generationId, status: 'committed' },
            { projection: { id: 1, delivered: 1, lastDeliveredEventId: 1, eventCount: 1, outboxPending: 1 } });
          if (!current) throw new CommandRecoveryError('An acknowledged outbox command is missing.');
          checkOutboxCursor(current);
          if (current.delivered! < delivered || current.eventCount !== command.eventCount) assertChanged(0);
        }
      });
    }
  }

  #wake(wait = 0) {
    const publish = this.options.publish;
    if (!publish || this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.deliverPending(publish).catch(() => this.#wake(1000));
    }, wait);
    this.#timer.unref();
  }
}
