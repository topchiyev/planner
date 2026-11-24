import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { CommandGate } from '../application/command-gate/gate.js';
import { CommandJournal } from '../application/command-journal/journal.js';
import { CommandRecoveryError } from '../application/command-journal/operation.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

export function startNativeCommandRecovery(config: NativeInstallationConfig, gate: CommandGate) {
  let stopped = false;
  let warned = false;
  let timer: NodeJS.Timeout | undefined;
  const attempt = async () => {
    if (stopped || (gate.state !== 'starting' && gate.state !== 'maintenance')) return;
    try {
      const client = await connectConfiguredNativeMongo(config);
      try {
        if (!stopped) await new CommandJournal(gate, client.db(databaseName), config.installationId).recover();
      } finally { await client.close(); }
    } catch (error) {
      if (stopped) return;
      if (!warned) {
        console.error('Planner command recovery could not be completed.');
        warned = true;
      }
      if (!(error instanceof CommandRecoveryError)) {
        timer = setTimeout(() => void attempt(), 1_000);
        timer.unref();
      }
    }
  };
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
