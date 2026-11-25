import type { KeyObject } from 'node:crypto';
import type { NativeInstallationConfig } from '@planner/contracts/native';
import type { MongoClient } from 'mongodb';
import { createBoardEventCursors } from '../application/board-events/cursor.js';
import { createBoardEventStreams } from '../application/board-events/streams.js';
import type { CommandGate } from '../application/command-gate/gate.js';
import { createMcpBoardSubscriptions } from '../application/mcp/board-subscriptions.js';
import { CommandJournal } from '../application/command-journal/journal.js';
import { databaseName } from './mongo-identity.js';
import { connectConfiguredNativeMongo } from './mongo-readiness.js';

const outboxIntervalMs = 1_000;

export function startNativeBoardEvents(config: NativeInstallationConfig, gate: CommandGate, installationKey: KeyObject) {
  let client: Promise<MongoClient> | undefined;
  let dispatcher: CommandJournal | undefined;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;
  let needsWake = false;
  const getDatabase = async () => {
    if (stopped) throw new Error('The board event runtime is stopped.');
    client ??= connectConfiguredNativeMongo(config).catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return (await client).db(databaseName);
  };

  const cursors = createBoardEventCursors(installationKey);
  const mcp = createMcpBoardSubscriptions();
  const streams = createBoardEventStreams(getDatabase, config.installationId, gate, cursors, { mcp });

  async function dispatch() {
    if (!gate.ready) {
      streams.disconnectAll();
      return;
    }
    const database = await getDatabase();
    if (stopped || !gate.ready) return;
    dispatcher ??= new CommandJournal(gate, database, config.installationId);
    await dispatcher.deliverPending(streams.accept);
  }

  function schedule(delay: number) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      active = dispatch().catch(() => {
        streams.disconnectAll();
      }).finally(() => {
        active = undefined;
        const delay = needsWake ? 0 : outboxIntervalMs;
        needsWake = false;
        schedule(delay);
      });
    }, delay);
    timer.unref();
  }

  schedule(0);
  return {
    cursors,
    streams,
    mcp,
    wake() {
      if (active) needsWake = true;
      else schedule(0);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      streams.stop();
      dispatcher?.stopDelivery();
    },
    async close() {
      await active;
      await (await client?.catch(() => undefined))?.close();
    },
  };
}

export type NativeBoardEvents = ReturnType<typeof startNativeBoardEvents>;
