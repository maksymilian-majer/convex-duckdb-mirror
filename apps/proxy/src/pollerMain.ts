import pino from "pino";
import { loadProxyConfig } from "./config.js";
import { assertBigIntJsonRuntime } from "./convexJson.js";
import { startDeltaPollSchedule } from "./poller.js";
import { openDeltasStore } from "./store.js";

assertBigIntJsonRuntime();

const config = loadProxyConfig();
const store = openDeltasStore(config.dataDir);
const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "convex-duckdb-poller" },
});

const schedule = startDeltaPollSchedule(
  {
    store,
    convex: {
      baseUrl: config.convexBaseUrl,
      deployKey: config.convexDeployKey,
    },
    retentionHours: config.retentionHours,
    log,
  },
  config.pollIntervalSeconds,
);

log.info(
  {
    dataDir: config.dataDir,
    pollIntervalSeconds: config.pollIntervalSeconds,
    retentionHours: config.retentionHours,
  },
  "Document delta poller started",
);

function shutdown(signal: string): void {
  log.info({ signal }, "Document delta poller shutting down");
  schedule.stop();
  store.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
