import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { Db } from 'mongodb';
import type { CommandGate } from '../application/command-gate/gate.js';
import { CommandJournal } from '../application/command-journal/journal.js';
import { CommandRecoveryError } from '../application/command-journal/operation.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export function keepCommandRecovery(gate: CommandGate, recover: (running: () => boolean) => Promise<void>) {
  let stopped = false;
  let warned = false;
  let timer: NodeJS.Timeout | undefined;
  const running = () => !stopped && (gate.state === 'starting' || gate.state === 'maintenance');
  const attempt = async () => {
    try {
      if (running()) await recover(running);
      warned = false;
    } catch (error) {
      if (stopped) return;
      if (!warned) {
        console.error('Planner command recovery could not be completed.');
        warned = true;
      }
      if (error instanceof CommandRecoveryError) return;
    }
    if (!stopped) {
      timer = setTimeout(() => void attempt(), 1_000);
      timer.unref();
    }
  };
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function startNativeCommandRecovery(
  config: NativeInstallationConfig, gate: CommandGate,
  recoverPrivate?: (database: Db, installationId: string) => Promise<void>,
  verifyBeforeReplay?: (database: Db, installationId: string) => Promise<void>,
) {
  return keepCommandRecovery(gate, async (running) => {
    const client = await connectConfiguredNativeMongo(config);
    try {
      const database = client.db(databaseName);
      if (running()) await new CommandJournal(gate, database, config.installationId).recover(
        recoverPrivate && (() => recoverPrivate(database, config.installationId)),
      );
    } finally { await client.close(); }
  });
}
