import { MongoServerError, type Db } from 'mongodb';
import { openActiveWorkspace } from '../../storage/scoped.js';
import { assertWorkspaceWritable } from '../migration/cutover.js';
import { CleanCommandRejection, type CommandGate, GateUnavailableError } from './gate.js';

type Workspace = Awaited<ReturnType<typeof openActiveWorkspace>>;
type WorkspaceReader = Pick<Workspace, 'generationId' | 'read'>;

function definitelyRejectedDuplicate(error: unknown) {
  return error instanceof MongoServerError && error.constructor === MongoServerError
    && error.code === 11_000 && error.errorResponse.index === 0
    && error.writeConcernError === undefined && error.errorLabels.length === 0;
}

async function useWorkspace<T>(workspace: Workspace, operation: (workspace: Workspace) => T | Promise<T>) {
  let available = true;
  let mutated = false;
  const started: { pending: Promise<unknown>; singleDocumentInsertOrUpdate: boolean }[] = [];
  const start = <Result>(work: () => Promise<Result>, changed?: (result: Result) => boolean,
    singleDocumentInsertOrUpdate = false) => {
    if (!available) return Promise.reject<Result>(new GateUnavailableError());
    const result = work().then((value) => {
      if (changed?.(value)) mutated = true;
      return value;
    });
    // Keep ownership even when a caller drops an operation's promise.
    void result.catch(() => {});
    started.push({ pending: result, singleDocumentInsertOrUpdate });
    return result;
  };
  const scoped: Workspace = Object.freeze({
    generationId: workspace.generationId,
    read: (...args: Parameters<Workspace['read']>) => start(() => workspace.read(...args)),
    insert: (...args: Parameters<Workspace['insert']>) => start(() => workspace.insert(...args), () => true, true),
    update: (...args: Parameters<Workspace['update']>) => start(() => workspace.update(...args), (changed) => changed, true),
    delete: (...args: Parameters<Workspace['delete']>) => start(() => workspace.delete(...args), (changed) => changed),
  });
  try {
    const result = await operation(scoped);
    available = false;
    await Promise.all(started.map(({ pending }) => pending));
    return result;
  } catch (error) {
    available = false;
    const settled = await Promise.allSettled(started.map(({ pending }) => pending));
    if (error instanceof CleanCommandRejection) {
      // These adapter calls write one document on the verified standalone server.
      const failure = settled.find((entry, index) => entry.status === 'rejected'
        && !(started[index].singleDocumentInsertOrUpdate && definitelyRejectedDuplicate(entry.reason)));
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
      return gate.runCommand(async () => {
        const workspace = await openActiveWorkspace(database, installationId);
        if (await assertWorkspaceWritable(database, installationId, workspace.generationId)) {
          throw new CleanCommandRejection('Migrated workspace writes require a journaled command.');
        }
        return useWorkspace(workspace, operation);
      });
    },
  };
}
