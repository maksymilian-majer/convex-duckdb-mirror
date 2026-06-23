import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDuckdbDeltaCollections,
  type DeltaEvent,
  type LatestCollectionEvents,
} from "./applySnapshotDeltas.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "livemarks-apply-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function deltaEvent(
  offset: number,
  collection: string,
  id: string,
  document: Record<string, unknown> | null,
): DeltaEvent {
  return {
    offset,
    collection,
    id,
    deleted: document === null,
    document,
  };
}

function collectionEvents(collection: string, events: DeltaEvent[]): LatestCollectionEvents {
  return {
    collection,
    eventsById: new Map(events.map((event) => [event.id, event])),
  };
}

async function applyTestDeltas(
  duckdbPath: string,
  collections: LatestCollectionEvents[],
): Promise<Awaited<ReturnType<typeof applyDuckdbDeltaCollections>>> {
  const appliedEventCount = collections.reduce(
    (total, collection) => total + collection.eventsById.size,
    0,
  );
  const maxAppliedDeltaOffset = Math.max(
    0,
    ...collections.flatMap((collection) =>
      Array.from(collection.eventsById.values(), (event) => event.offset),
    ),
  );
  return applyDuckdbDeltaCollections({
    duckdbPath,
    collections,
    appliedEventCount,
    maxAppliedDeltaOffset,
  });
}

async function duckDbRows(
  duckdbPath: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const instance = await DuckDBInstance.create(duckdbPath);
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects();
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function seedDuckDbTable(
  duckdbPath: string,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const seedPath = join(dirname(duckdbPath), `${table}.jsonl`);
  writeJsonl(seedPath, rows);

  const instance = await DuckDBInstance.create(duckdbPath);
  const connection = await instance.connect();
  try {
    await connection.run(
      `CREATE TABLE "${table}" AS SELECT * FROM read_json_auto('${seedPath}', maximum_object_size=16777216, union_by_name=true)`,
    );
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe("applyDuckdbDeltaCollections", () => {
  it("applies insert, update, and delete from compacted events", async () => {
    const dir = tempDir();
    const duckdbPath = join(dir, "test.duckdb");

    await seedDuckDbTable(duckdbPath, "tweets", [
      { _id: "a", text: "old a" },
      { _id: "b", text: "old b" },
    ]);
    const summary = await applyTestDeltas(duckdbPath, [
      collectionEvents("tweets", [
        deltaEvent(1, "tweets", "c", { _id: "c", text: "new c" }),
        deltaEvent(2, "tweets", "b", null),
        deltaEvent(3, "tweets", "a", { _id: "a", text: "latest a" }),
      ]),
    ]);

    expect(summary.collections.tweets.beforeRowCount).toBe(2);
    expect(summary.collections.tweets.afterRowCount).toBe(2);
    await expect(duckDbRows(duckdbPath, 'SELECT * FROM "tweets" ORDER BY _id')).resolves.toEqual([
      { _id: "a", text: "latest a" },
      { _id: "c", text: "new c" },
    ]);
  });

  it("uses INSERT BY NAME for missing source columns", async () => {
    const dir = tempDir();
    const duckdbPath = join(dir, "test.duckdb");

    await seedDuckDbTable(duckdbPath, "tweets", [{ _id: "a", text: "old", optional: "x" }]);
    await applyTestDeltas(duckdbPath, [
      collectionEvents("tweets", [deltaEvent(0, "tweets", "a", { _id: "a", text: "new" })]),
    ]);

    await expect(duckDbRows(duckdbPath, 'SELECT * FROM "tweets"')).resolves.toEqual([
      { _id: "a", text: "new", optional: null },
    ]);
  });

  it("replaces an empty `(_id VARCHAR)` stub table with the full upsert schema", async () => {
    const dir = tempDir();
    const duckdbPath = join(dir, "test.duckdb");

    // A collection that was empty at snapshot time is materialized as a stub
    // with only an `_id` column.
    const instance = await DuckDBInstance.create(duckdbPath);
    const connection = await instance.connect();
    try {
      await connection.run('CREATE TABLE "tweets" (_id VARCHAR)');
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }

    const summary = await applyTestDeltas(duckdbPath, [
      collectionEvents("tweets", [
        deltaEvent(0, "tweets", "a", { _id: "a", text: "hello", value: 1 }),
      ]),
    ]);

    expect(summary.collections.tweets.beforeRowCount).toBe(0);
    expect(summary.collections.tweets.afterRowCount).toBe(1);
    // `SELECT *` proves the stub's lone `_id` column was replaced by the full
    // upsert schema; node-api surfaces the BIGINT `value` as a JS BigInt.
    await expect(duckDbRows(duckdbPath, 'SELECT * FROM "tweets"')).resolves.toEqual([
      { _id: "a", text: "hello", value: 1n },
    ]);
  });
});
