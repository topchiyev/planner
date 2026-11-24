import type { Db } from 'mongodb';
import { openActiveWorkspace } from '../../storage/scoped.js';
import { CleanCommandRejection, type CommandGate, GateUnavailableError } from './gate.js';

type Workspace = Awaited<ReturnType<typeof openActiveWorkspace>>;
type WorkspaceReader = Pick<Workspace, 'generationId' | 'read'>;

async function useWorkspace<T>(workspace: Workspace, operation: (workspace: Workspace) => T | Promise<T>) {
  let available = true;
  let mutated = false;
  const started: Promise<unknown>[] = [];
  const start = <Result>(work: () => Promise<Result>, changed?: (result: Result) => boolean) => {
    if (!available) return Promise.reject<Result>(new GateUnavailableError());
    const result = work().then((value) => {
      if (changed?.(value)) mutated = true;
      return value;
    });
    // Keep ownership even when a caller drops an operation's promise.
    void result.catch(() => {});
    started.push(result);
    return result;
  };
  const scoped: Workspace = Object.freeze({
    generationId: workspace.generationId,
    read: (...args: Parameters<Workspace['read']>) => start(() => workspace.read(...args)),
    insert: (...args: Parameters<Workspace['insert']>) => start(() => workspace.insert(...args), () => true),
    update: (...args: Parameters<Workspace['update']>) => start(() => workspace.update(...args), (changed) => changed),
    delete: (...args: Parameters<Workspace['delete']>) => start(() => workspace.delete(...args), (changed) => changed),
  });
  try {
    const result = await operation(scoped);
    available = false;
    await Promise.all(started);
    return result;
  } catch (error) {
    available = false;
    const settled = await Promise.allSettled(started);
    if (error instanceof CleanCommandRejection) {
      const failure = settled.find((entry) => entry.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      if (mutated) throw new Error('The command applied effects before it failed.', { cause: error });
    }
    throw error;
  }
}

// Active-generation changes also take this gate's runCommand slot, or the offline writer lease.
export function createWorkspaceAccess(gate: CommandGate, database: Db, installationId: string) {
  return {
    readSnapshot<T>(operation: (workspace: WorkspaceReader) => T | Promise<T>) {
      return gate.readSnapshot(async () => useWorkspace(await openActiveWorkspace(database, installationId), (workspace) => (
        operation(Object.freeze({ generationId: workspace.generationId, read: workspace.read }))
      )));
    },
    runCommand<T>(operation: (workspace: Workspace) => T | Promise<T>) {
      return gate.runCommand(async () => useWorkspace(await openActiveWorkspace(database, installationId), operation));
    },
  };
}
