import type { WriterLease } from './writer-lease.js';

export class GateUnavailableError extends Error {
  constructor() { super('Planner is unavailable.'); }
}

// A command can use this rejection only before applying effects or after confirming rollback.
export class CleanCommandRejection extends Error {}

export type GateState = 'starting' | 'open' | 'maintenance' | 'recovering' | 'closing' | 'closed';

type Kind = 'read' | 'command';
interface QueuedOperation {
  kind: Kind;
  start: () => void;
  reject: (error: GateUnavailableError) => void;
}

export class CommandGate {
  readonly #lease: WriterLease;
  #state: GateState = 'starting';
  #queue: QueuedOperation[] = [];
  #readers = 0;
  #writer = false;
  #closing?: Promise<void>;
  #finishClose?: () => void;

  constructor(lease: WriterLease) {
    this.#lease = lease.transfer();
  }

  get state() { return this.#state; }
  get ready() { return this.#state === 'open' && this.#lease.held; }

  // Resolve authorization and materialize the result or authorized file handle inside this callback.
  readSnapshot<T>(materialize: () => T | Promise<T>): Promise<T> {
    return this.#submit('read', materialize);
  }

  runCommand<T>(execute: () => T | Promise<T>): Promise<T> {
    return this.#submit('command', execute);
  }

  async recover(replay: () => void | Promise<void>) {
    if (this.#state !== 'starting' && this.#state !== 'maintenance') throw new GateUnavailableError();
    if (this.#readers || this.#writer) throw new GateUnavailableError();
    this.#lease.assertHeld();
    this.#writer = true;
    this.#state = 'recovering';
    try {
      await replay();
      if (this.state === 'recovering') this.#state = 'open';
    } catch (error) {
      if (this.state === 'recovering') this.#state = 'maintenance';
      throw error;
    } finally {
      this.#writer = false;
      this.#advance();
    }
  }

  closeAndDrain() {
    if (this.#closing) return this.#closing;
    this.#state = 'closing';
    this.#rejectQueue();
    this.#closing = new Promise((resolve, reject) => {
      this.#finishClose = () => {
        this.#finishClose = undefined;
        this.#state = 'closed';
        try { this.#lease.release(); resolve(); } catch (error) { reject(error); }
      };
    });
    this.#advance();
    return this.#closing;
  }

  #submit<T>(kind: Kind, operation: () => T | Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      if (!this.ready) throw new GateUnavailableError();
      this.#lease.assertHeld();
      this.#queue.push({ kind, reject, start: () => {
        void this.#run(kind, operation, resolve, reject);
      } });
      this.#advance();
    });
  }

  async #run<T>(kind: Kind, operation: () => T | Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void) {
    try {
      // A caller disconnect has no bearing on the lifetime of the storage operation.
      this.#lease.assertHeld();
      const value = await Promise.resolve().then(operation);
      if (this.#state === 'maintenance') throw new GateUnavailableError();
      resolve(value);
    } catch (error) {
      if (this.ready && !(error instanceof CleanCommandRejection)) {
        this.#state = 'maintenance';
        this.#rejectQueue();
      }
      reject(error);
    } finally {
      if (kind === 'read') this.#readers -= 1;
      else this.#writer = false;
      this.#advance();
    }
  }

  #rejectQueue() {
    for (const operation of this.#queue.splice(0)) operation.reject(new GateUnavailableError());
  }

  #advance() {
    if (this.#writer) return;
    if (this.#state === 'closing' && !this.#readers) this.#finishClose?.();
    while (this.ready && this.#queue.length > 0) {
      const operation = this.#queue[0];
      if (operation.kind === 'command') {
        if (this.#readers) return;
        this.#writer = true;
        this.#queue.shift();
        operation.start();
        return;
      }
      this.#readers += 1;
      this.#queue.shift();
      operation.start();
    }
  }
}
