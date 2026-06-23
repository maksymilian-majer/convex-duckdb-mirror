import cron from "node-cron";
import {
  type ConvexClientConfig,
  fetchGlobalDeltas,
  seedCursorFromSnapshot,
} from "./convexClient.js";
import type { DeltasStore } from "./store.js";

export interface PollLogger {
  info(messageOrObject: string | object, message?: string): void;
  warn(messageOrObject: string | object, message?: string): void;
  error(messageOrObject: string | object, message?: string): void;
}

export interface PollOptions {
  store: DeltasStore;
  convex: ConvexClientConfig;
  retentionHours: number;
  log: PollLogger;
}

export interface DeltaPollSchedule {
  stop: () => void;
}

export async function pollConvexDeltas(options: PollOptions): Promise<void> {
  const now = new Date().toISOString();
  const state = options.store.readState();
  let cursor = state.latestCursor;

  if (cursor === null) {
    cursor = await seedCursorFromSnapshot(options.convex);
    options.store.writeState({
      ...state,
      latestCursor: cursor,
      oldestCursor: state.oldestCursor ?? cursor,
      lastPollAt: now,
      lastError: null,
    });
    options.log.info({ cursor: cursor.toString() }, "Seeded document delta cursor");
    return;
  }

  let totalRows = 0;
  let latestCursor = cursor;
  let lastEventAt = state.lastEventAt;

  while (true) {
    const page = await fetchGlobalDeltas(options.convex, latestCursor);
    const receivedAt = new Date().toISOString();
    options.store.appendDeltas(page.values, receivedAt);

    totalRows += page.values.length;
    latestCursor = page.cursor;
    if (page.values.length > 0) {
      lastEventAt = receivedAt;
    }
    if (!page.hasMore) break;
  }

  const nextOldestCursor = options.store.removeDeltasOlderThanRetentionPeriod(
    options.retentionHours,
    latestCursor,
  );
  options.store.writeState({
    ...state,
    latestCursor,
    oldestCursor: nextOldestCursor ?? state.oldestCursor ?? cursor,
    lastPollAt: now,
    lastEventAt,
    lastError: null,
  });

  options.log.info(
    { rows: totalRows, cursor: latestCursor.toString() },
    "Document delta poll complete",
  );
}

export function startDeltaPollSchedule(
  options: PollOptions,
  intervalSeconds: number,
): DeltaPollSchedule {
  let running = false;

  const runPoll = async () => {
    if (running) {
      options.log.warn("Skipping document delta poll because previous poll is still running");
      return;
    }

    running = true;
    try {
      await pollConvexDeltas(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = options.store.readState();
      options.store.writeState({
        ...state,
        lastPollAt: new Date().toISOString(),
        lastError: { at: new Date().toISOString(), message },
      });
      options.log.error({ error }, "Document delta poll failed");
    } finally {
      running = false;
    }
  };

  const expression = `*/${intervalSeconds} * * * * *`;
  if (!cron.validate(expression)) {
    throw new Error(`Invalid document delta poll interval: ${intervalSeconds}s`);
  }

  const task = cron.schedule(expression, runPoll, {
    name: "convex-duckdb-poll",
    noOverlap: true,
  });
  void task.execute();

  return {
    stop: () => {
      task.stop();
    },
  };
}
