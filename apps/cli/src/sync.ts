import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  applyDuckdbDeltaCollections,
  type DeltaEvent,
  type LatestCollectionEvents,
} from "./applySnapshotDeltas.js";
import {
  buildDuckdbFromSnapshot,
  listDuckdbTables,
  tableRowCounts,
} from "./buildDuckdbFromSnapshot.js";
import { type Config, isInvalidWindowError, mirrorGet } from "./http.js";
import { poolMap } from "./pool.js";
import {
  acquireLock,
  checkLock,
  isOrphanedLock,
  readMetadata,
  readSyncState,
  releaseLock,
  type SyncState,
  writeMetadata,
  writeSyncState,
} from "./state.js";

export const REPO_ROOT = resolve(process.env.INIT_CWD ?? process.cwd());
export const LOCAL_DIR = join(REPO_ROOT, ".convex-duckdb");
export const SNAPSHOT_DIR = join(LOCAL_DIR, "snapshot");
export const DUCKDB_PATH = join(LOCAL_DIR, "data.duckdb");

const STAGING_DIR = join(LOCAL_DIR, "snapshot-staging");
const STATE_PATHS = {
  metadataFile: join(SNAPSHOT_DIR, "metadata.json"),
  syncStateFile: join(SNAPSHOT_DIR, "sync-state.json"),
};
const SNAPSHOT_CONCURRENCY = 12;

interface SnapshotPageTimings {
  pageCount: number;
  totalBytes: number;
  totalFetchMs: number;
  totalAppendMs: number;
  totalRows: number;
}

interface SnapshotPage {
  values: Array<Record<string, unknown>>;
  cursor: string;
  snapshot: string;
  hasMore: boolean;
}

interface DocumentDeltasPage {
  values: Array<Record<string, unknown>>;
  cursor: string;
  hasMore: boolean;
}

export interface SyncResult {
  mode: "full" | "delta" | "noop";
  durationMs: number;
}

export interface LocalStatus {
  duckdbPath: string;
  duckdbExists: boolean;
  status: "missing" | "syncing" | "orphaned_lock" | "ready" | "database_missing";
  message: string;
  updatedAt: string | null;
  lastAppliedCursor: string | null;
  lock: {
    pid?: number;
    startedAt?: string;
    elapsedSeconds: number;
  } | null;
}

async function discoverCollections(config: Config): Promise<string[]> {
  const json = await mirrorGet<Record<string, unknown>>(config, "/api/json_schemas", {
    format: "json",
  });
  return Object.keys(json)
    .filter((collection) => !collection.startsWith("_"))
    .sort();
}

async function seedSnapshotCursor(config: Config, firstCollection: string): Promise<string> {
  const page = await mirrorGet<SnapshotPage>(config, "/api/list_snapshot", {
    tableName: firstCollection,
    format: "json",
  });
  return timestampCursorToString(page.snapshot, "snapshot");
}

async function snapshotCollection(
  config: Config,
  collection: string,
  snapshot: string,
  jsonlPath: string,
  debug: boolean,
): Promise<{
  collection: string;
  rowCount: number;
  sizeBytes: number;
  timings: SnapshotPageTimings;
}> {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, "");

  let cursor: string | undefined;
  let rowCount = 0;
  let pageCount = 0;
  let totalBytes = 0;
  let totalFetchMs = 0;
  let totalAppendMs = 0;

  while (true) {
    const params: Record<string, string> = {
      tableName: collection,
      format: "json",
      snapshot,
    };
    if (cursor) params.cursor = cursor;

    const fetchStartedAt = performance.now();
    const page = await mirrorGet<SnapshotPage>(config, "/api/list_snapshot", params);
    const fetchMs = performance.now() - fetchStartedAt;
    totalFetchMs += fetchMs;

    if (!Array.isArray(page.values)) {
      throw new Error(`Unexpected /api/list_snapshot values for ${collection}.`);
    }

    pageCount += 1;
    let appendMs = 0;
    let pageBytes = 0;
    if (page.values.length > 0) {
      const appendStartedAt = performance.now();
      const chunk = `${page.values.map((row) => JSON.stringify(stripExportFields(row))).join("\n")}\n`;
      appendFileSync(jsonlPath, chunk);
      appendMs = performance.now() - appendStartedAt;
      pageBytes = Buffer.byteLength(chunk, "utf8");
      totalBytes += pageBytes;
      rowCount += page.values.length;
    }
    totalAppendMs += appendMs;

    if (debug) {
      console.log(
        `    [debug] ${collection} page ${pageCount}: ${formatBytes(pageBytes)}, fetch ${formatDuration(fetchMs)}, append ${formatDuration(appendMs)}, ${page.values.length} rows`,
      );
    }

    if (!page.hasMore) break;
    cursor = snapshotPageCursorToString(page.cursor, "cursor");
  }

  return {
    collection,
    rowCount,
    sizeBytes: statSync(jsonlPath).size,
    timings: {
      pageCount,
      totalBytes,
      totalFetchMs,
      totalAppendMs,
      totalRows: rowCount,
    },
  };
}

function stripExportFields(row: Record<string, unknown>): Record<string, unknown> {
  const { _table, _ts, _deleted, ...document } = row;
  return document;
}

function cleanDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

async function performFullRestore(config: Config, debug: boolean): Promise<SyncResult> {
  const started = performance.now();
  console.log("==> Discovering Convex collections...");
  const collections = await discoverCollections(config);
  if (collections.length === 0) {
    throw new Error("Convex returned 0 collections from /api/json_schemas.");
  }

  console.log("==> Seeding consistent snapshot cursor...");
  const snapshot = await seedSnapshotCursor(config, collections[0]);
  console.log(`    Snapshot cursor ${snapshot}`);

  cleanDir(STAGING_DIR);
  try {
    console.log(`==> Downloading ${collections.length} collections from mirror snapshot...`);
    const downloadStartedAt = performance.now();
    const results = await poolMap(
      collections,
      async (collection) => {
        const result = await snapshotCollection(
          config,
          collection,
          snapshot,
          join(STAGING_DIR, `${collection}.jsonl`),
          debug,
        );
        console.log(`    ${collection}: snapshot (${result.rowCount} rows)`);
        return result;
      },
      SNAPSHOT_CONCURRENCY,
    );
    const downloadDurationMs = performance.now() - downloadStartedAt;
    const downloadStats = summarizeSnapshotDownloads(results);
    if (debug) {
      console.log(
        `    [debug] Snapshot download: ${downloadStats.pageCount} pages, ${formatBytes(downloadStats.totalBytes)}, fetch ${formatDuration(downloadStats.totalFetchMs)}, append ${formatDuration(downloadStats.totalAppendMs)}, wall ${formatDuration(downloadDurationMs)}, ${formatThroughput(downloadStats.totalBytes, downloadDurationMs)}`,
      );
    }

    console.log("==> Building DuckDB from mirror snapshot...");
    const tables = await buildDuckdbFromSnapshot(STAGING_DIR, DUCKDB_PATH);
    const updatedAt = new Date().toISOString();
    const state: SyncState = {
      lastAppliedCursor: snapshot,
      updatedAt,
    };

    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    rmSync(STAGING_DIR, { recursive: true, force: true });
    await writeSyncState(STATE_PATHS, state);
    await releaseLock(STATE_PATHS, state);

    const durationMs = performance.now() - started;
    console.log(
      `\n==> Full mirror restore complete: ${tables.length} tables, cursor ${snapshot}, ${formatDuration(durationMs)}`,
    );
    return { mode: "full", durationMs };
  } catch (error) {
    rmSync(STAGING_DIR, { recursive: true, force: true });
    throw error;
  }
}

async function fetchProxyDeltas(
  config: Config,
  cursor: string,
): Promise<{
  eventCount: number;
  newCursor: string;
  pageCount: number;
  collections: LatestCollectionEvents[];
}> {
  let currentCursor = cursor;
  let eventCount = 0;
  let offset = 0;
  let pageCount = 0;
  const collections = new Map<string, LatestCollectionEvents>();

  while (true) {
    const page = await mirrorGet<DocumentDeltasPage>(config, "/api/document_deltas", {
      format: "json",
      cursor: currentCursor,
    });
    pageCount++;

    if (!Array.isArray(page.values)) {
      throw new Error("Unexpected proxy /api/document_deltas values.");
    }

    if (page.values.length > 0) {
      const events = page.values.map((row) => normalizeDeltaRow(row, ++offset));
      eventCount += events.length;

      for (const event of events) {
        let collection = collections.get(event.collection);
        if (!collection) {
          collection = { collection: event.collection, eventsById: new Map() };
          collections.set(event.collection, collection);
        }

        const previous = collection.eventsById.get(event.id);
        if (!previous || event.offset > previous.offset) {
          collection.eventsById.set(event.id, event);
        }
      }
    }

    currentCursor = maxCursorString(currentCursor, timestampCursorToString(page.cursor, "cursor"));
    if (!page.hasMore) break;
  }

  return {
    eventCount,
    newCursor: currentCursor,
    pageCount,
    collections: Array.from(collections.values()).sort((a, b) =>
      a.collection.localeCompare(b.collection),
    ),
  };
}

function normalizeDeltaRow(row: Record<string, unknown>, offset: number): DeltaEvent {
  const collection = row._table;
  const id = row._id;
  if (typeof collection !== "string" || collection.length === 0) {
    throw new Error("Proxy delta row is missing string _table.");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Proxy delta row for ${collection} is missing string _id.`);
  }

  const deleted = row._deleted === true;
  return {
    offset,
    collection,
    id,
    deleted,
    document: deleted ? null : stripExportFields(row),
  };
}

async function performIncrementalSync(config: Config, debug: boolean): Promise<SyncResult> {
  const state = readSyncState(STATE_PATHS);
  if (!state || !existsSync(DUCKDB_PATH)) {
    console.log("==> No local DuckDB sync state found; performing full restore.");
    return performFullRestore(config, debug);
  }

  const started = performance.now();

  console.log(`==> Fetching mirror deltas since cursor ${state.lastAppliedCursor}...`);
  try {
    const fetchStarted = performance.now();
    const deltas = await fetchProxyDeltas(config, state.lastAppliedCursor);
    const fetchDurationMs = performance.now() - fetchStarted;
    console.log(
      `    Fetch: ${deltas.eventCount} events across ${deltas.pageCount} pages, ${formatDuration(fetchDurationMs)}`,
    );

    if (deltas.eventCount === 0) {
      const nextState = await refreshStateTimestamp(state, deltas.newCursor);
      const durationMs = performance.now() - started;
      console.log(
        `\n==> Mirror delta sync complete: no changes, cursor ${nextState.lastAppliedCursor}, ${formatDuration(durationMs)}`,
      );
      return { mode: "noop", durationMs };
    }

    const duckdbStarted = performance.now();
    const duckdbSummary = await applyDuckdbDeltaCollections({
      duckdbPath: DUCKDB_PATH,
      collections: deltas.collections,
      appliedEventCount: deltas.eventCount,
      maxAppliedDeltaOffset: deltas.eventCount,
    });
    const duckdbDurationMs = performance.now() - duckdbStarted;
    console.log(
      `    DuckDB apply: ${duckdbSummary.appliedEventCount} events across ${duckdbSummary.affectedCollections.length} collections, ${formatDuration(duckdbDurationMs)}`,
    );

    const updatedAt = new Date().toISOString();
    const nextState: SyncState = {
      lastAppliedCursor: deltas.newCursor,
      updatedAt,
    };

    await writeSyncState(STATE_PATHS, nextState);
    await releaseLock(STATE_PATHS, nextState);

    const durationMs = performance.now() - started;
    console.log(
      `\n==> Mirror delta sync complete: ${duckdbSummary.appliedEventCount} events across ${duckdbSummary.affectedCollections.length} collections, cursor ${nextState.lastAppliedCursor}, ${formatDuration(durationMs)}`,
    );
    return { mode: "delta", durationMs };
  } catch (error) {
    if (isInvalidWindowError(error)) {
      console.log("==> Proxy retention window expired; performing full restore.");
      return performFullRestore(config, debug);
    }
    throw error;
  }
}

async function refreshStateTimestamp(state: SyncState, newCursor: string): Promise<SyncState> {
  const nextState: SyncState = {
    lastAppliedCursor: maxCursorString(state.lastAppliedCursor, newCursor),
    updatedAt: new Date().toISOString(),
  };
  await writeSyncState(STATE_PATHS, nextState);
  await releaseLock(STATE_PATHS, nextState);
  return nextState;
}

export async function performSync(
  config: Config,
  options: { full: boolean; force: boolean; debug: boolean },
): Promise<SyncResult> {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const priorMetadata = readMetadata(STATE_PATHS);
  checkLock(STATE_PATHS, options.force);
  await acquireLock(STATE_PATHS);

  try {
    return options.full
      ? await performFullRestore(config, options.debug)
      : await performIncrementalSync(config, options.debug);
  } catch (error) {
    const meta = readMetadata(STATE_PATHS);
    if (meta?.status === "syncing" && meta.pid === process.pid) {
      if (priorMetadata) {
        await writeMetadata(STATE_PATHS, priorMetadata);
      } else {
        await writeMetadata(STATE_PATHS, { ...meta, status: "ready" });
      }
    }
    throw error;
  }
}

export function getLocalStatus(): LocalStatus {
  const meta = readMetadata(STATE_PATHS);
  const state = readSyncState(STATE_PATHS);
  const duckdbExists = existsSync(DUCKDB_PATH);
  const base = {
    duckdbPath: DUCKDB_PATH,
    duckdbExists,
    updatedAt: state?.updatedAt ?? null,
    lastAppliedCursor: state?.lastAppliedCursor ?? null,
    lock: null,
  };

  if (!meta) {
    return {
      ...base,
      status: "missing",
      message: "No snapshot found. Run: npx convex-duckdb sync",
    };
  }

  if (meta.status === "syncing") {
    const startedAt = meta.startedAt ? new Date(meta.startedAt).getTime() : 0;
    const elapsed = Date.now() - startedAt;
    const lock = {
      ...(meta.pid !== undefined ? { pid: meta.pid } : {}),
      ...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
      elapsedSeconds: Math.round(elapsed / 1000),
    };
    if (isOrphanedLock(meta)) {
      return {
        ...base,
        status: "orphaned_lock",
        message: `Orphaned lock (pid ${meta.pid} is not running, started ${Math.round(
          elapsed / 1000,
        )}s ago). Safe to re-run sync.`,
        lock,
      };
    }
    return {
      ...base,
      status: "syncing",
      message: `Sync in progress (pid ${meta.pid ?? "unknown"}, started ${Math.round(
        elapsed / 1000,
      )}s ago)`,
      lock,
    };
  }

  const parts = [
    duckdbExists ? "DuckDB ready" : "DuckDB not built (run: npx convex-duckdb sync)",
  ];
  const ageMs = state?.updatedAt ? Date.now() - new Date(state.updatedAt).getTime() : null;

  if (ageMs !== null) {
    parts.push(`synced ${formatAge(ageMs)}`);
  }
  if (state?.lastAppliedCursor) {
    parts.push(`cursor ${state.lastAppliedCursor}`);
  }

  return {
    ...base,
    status: duckdbExists ? "ready" : "database_missing",
    message: parts.join(", "),
  };
}

export async function printRowCounts(): Promise<void> {
  const tables = await listDuckdbTables(DUCKDB_PATH);
  const counts = await tableRowCounts(DUCKDB_PATH, tables);
  if (counts.length === 0) return;

  console.log("\n==> Table row counts:");
  const width = Math.max(...counts.map((entry) => entry.name.length), 5);
  for (const entry of counts) {
    console.log(`    ${entry.name.padEnd(width)}  ${entry.rows}`);
  }
}

function timestampCursorToString(value: unknown, fieldName: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new Error(`Expected ${fieldName} to be an unsigned integer.`);
}

function snapshotPageCursorToString(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new Error(`Expected ${fieldName} to be a non-empty snapshot page cursor.`);
}

function maxCursorString(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function summarizeSnapshotDownloads(
  results: Array<{ timings: SnapshotPageTimings }>,
): SnapshotPageTimings {
  return results.reduce<SnapshotPageTimings>(
    (summary, result) => ({
      pageCount: summary.pageCount + result.timings.pageCount,
      totalBytes: summary.totalBytes + result.timings.totalBytes,
      totalFetchMs: summary.totalFetchMs + result.timings.totalFetchMs,
      totalAppendMs: summary.totalAppendMs + result.timings.totalAppendMs,
      totalRows: summary.totalRows + result.timings.totalRows,
    }),
    {
      pageCount: 0,
      totalBytes: 0,
      totalFetchMs: 0,
      totalAppendMs: 0,
      totalRows: 0,
    },
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatThroughput(bytes: number, durationMs: number): string {
  if (durationMs <= 0) return "0 B/s";
  const bytesPerSecond = bytes / (durationMs / 1000);
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s effective`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s effective`;
}
