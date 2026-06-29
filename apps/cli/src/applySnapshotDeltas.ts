import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

export interface DeltaEvent {
  offset: number;
  collection: string;
  id: string;
  deleted: boolean;
  document: Record<string, unknown> | null;
}

export interface CollectionApplySummary {
  collection: string;
  latestEventCount: number;
  upsertCount: number;
  deleteCount: number;
  beforeRowCount?: number;
  afterRowCount?: number;
}

export interface ApplySnapshotDeltasSummary {
  appliedEventCount: number;
  affectedCollections: string[];
  maxAppliedDeltaOffset: number;
  collections: Record<string, CollectionApplySummary>;
}

export const MAXIMUM_OBJECT_SIZE = 16_777_216;

export interface LatestCollectionEvents {
  collection: string;
  eventsById: Map<string, DeltaEvent>;
}

export interface ApplyDuckdbDeltaCollectionsOptions {
  duckdbPath: string;
  collections: LatestCollectionEvents[];
  appliedEventCount: number;
  maxAppliedDeltaOffset: number;
}

interface CollectionWorkFiles {
  idsFile: string;
  upsertsFile: string;
  hasUpserts: boolean;
}

export async function applyDuckdbDeltaCollections(
  options: ApplyDuckdbDeltaCollectionsOptions,
): Promise<ApplySnapshotDeltasSummary> {
  const summary = createInitialSummary({
    appliedEventCount: options.appliedEventCount,
    maxAppliedDeltaOffset: options.maxAppliedDeltaOffset,
    collections: options.collections,
  });

  if (summary.appliedEventCount === 0) {
    return summary;
  }

  await applyDuckDbDeltas(options.duckdbPath, options.collections, summary);
  return summary;
}

function createInitialSummary(scanned: {
  appliedEventCount: number;
  maxAppliedDeltaOffset: number;
  collections: LatestCollectionEvents[];
}): ApplySnapshotDeltasSummary {
  return {
    appliedEventCount: scanned.appliedEventCount,
    affectedCollections: scanned.collections.map((collection) => collection.collection),
    maxAppliedDeltaOffset: scanned.appliedEventCount > 0 ? scanned.maxAppliedDeltaOffset : 0,
    collections: Object.fromEntries(
      scanned.collections.map((collection) => {
        const events = Array.from(collection.eventsById.values());
        return [
          collection.collection,
          {
            collection: collection.collection,
            latestEventCount: events.length,
            upsertCount: events.filter((event) => !event.deleted).length,
            deleteCount: events.filter((event) => event.deleted).length,
          },
        ];
      }),
    ),
  };
}

async function applyDuckDbDeltas(
  duckdbPath: string,
  collections: LatestCollectionEvents[],
  summary: ApplySnapshotDeltasSummary,
): Promise<void> {
  mkdirSync(dirname(duckdbPath), { recursive: true });
  const instance = await DuckDBInstance.create(duckdbPath);
  const connection = await instance.connect();
  const workDir = createWorkDir();

  try {
    for (const collection of collections) {
      await applyDuckDbCollection(connection, collection, summary, workDir);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function applyDuckDbCollection(
  connection: DuckDBConnection,
  collection: LatestCollectionEvents,
  summary: ApplySnapshotDeltasSummary,
  workDir: string,
): Promise<void> {
  const workFiles = writeCollectionWorkFiles(collection, workDir);
  const tableName = collection.collection;
  const tableExists = await duckDbTableExists(connection, tableName);
  const beforeRowCount = tableExists ? await duckDbRowCount(connection, tableName) : 0;

  await resetTempTables(connection);
  await createIdsTable(connection, workFiles.idsFile);
  if (workFiles.hasUpserts) {
    await connection.run(
      `CREATE TEMP TABLE _upserts AS SELECT * FROM read_json_auto(${sqlString(workFiles.upsertsFile)}, maximum_object_size=${MAXIMUM_OBJECT_SIZE}, union_by_name=true)`,
    );
  }

  // An existing-but-empty table may be a schema-less stub (e.g. `(_id VARCHAR)`
  // created for a collection that was empty at snapshot time). Inserting into
  // such a stub `BY NAME` would drop every column the stub lacks, so recreate
  // the table from the first upsert batch instead — same as a missing table.
  const isEmptyTable = tableExists && beforeRowCount === 0;
  await connection.run("BEGIN TRANSACTION");
  try {
    if ((!tableExists || isEmptyTable) && workFiles.hasUpserts) {
      if (isEmptyTable) {
        await connection.run(`DROP TABLE IF EXISTS ${sqlIdentifier(tableName)}`);
      }
      await connection.run(`CREATE TABLE ${sqlIdentifier(tableName)} AS SELECT * FROM _upserts`);
    } else if (tableExists) {
      if (workFiles.hasUpserts) {
        await prepareTargetTableForUpserts(connection, tableName);
      }
      await connection.run(
        `DELETE FROM ${sqlIdentifier(tableName)} WHERE _id IN (SELECT _id FROM _latest_ids)`,
      );
      if (workFiles.hasUpserts) {
        await connection.run(
          `INSERT INTO ${sqlIdentifier(tableName)} BY NAME SELECT * FROM _upserts`,
        );
      }
    }
    await connection.run("COMMIT");
  } catch (error) {
    await connection.run("ROLLBACK").catch(() => undefined);
    throw error;
  }

  const afterTableExists = tableExists || workFiles.hasUpserts;
  const collectionSummary = summary.collections[collection.collection];
  collectionSummary.beforeRowCount = beforeRowCount;
  collectionSummary.afterRowCount = afterTableExists
    ? await duckDbRowCount(connection, tableName)
    : 0;
}

function writeCollectionWorkFiles(
  collection: LatestCollectionEvents,
  workDir: string,
): CollectionWorkFiles {
  const collectionFileStem = safeFileStem(collection.collection);
  const idsFile = join(workDir, `${collectionFileStem}-ids.jsonl`);
  const upsertsFile = join(workDir, `${collectionFileStem}-upserts.jsonl`);

  const events = Array.from(collection.eventsById.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const ids = events.map((event) => ({ _id: event.id }));
  const upserts = events
    .filter((event) => !event.deleted)
    .map((event) => {
      if (!event.document) {
        throw new Error(`Upsert event for ${collection.collection} has no document.`);
      }
      if (typeof event.document._id !== "string") {
        return { ...event.document, _id: event.id };
      }
      return event.document;
    });

  writeJsonl(idsFile, ids);
  if (upserts.length > 0) {
    writeJsonl(upsertsFile, upserts);
  }

  return {
    idsFile,
    upsertsFile,
    hasUpserts: upserts.length > 0,
  };
}

async function prepareTargetTableForUpserts(
  connection: DuckDBConnection,
  tableName: string,
): Promise<void> {
  const reader = await connection.runAndReadAll(`
    SELECT source.column_name, source.data_type
    FROM duckdb_columns() source
    LEFT JOIN duckdb_columns() target
      ON target.schema_name = 'main'
     AND target.table_name = ${sqlString(tableName)}
     AND target.column_name = source.column_name
    WHERE source.schema_name = 'main'
      AND source.table_name = '_upserts'
      AND target.column_name IS NULL
    ORDER BY source.column_index
  `);

  for (const row of reader.getRowObjects()) {
    await connection.run(
      `ALTER TABLE ${sqlIdentifier(tableName)}
       ADD COLUMN ${sqlIdentifier(String(row.column_name))} ${String(row.data_type)}`,
    );
  }
}

async function resetTempTables(connection: DuckDBConnection): Promise<void> {
  await connection.run("DROP TABLE IF EXISTS _upserts");
  await connection.run("DROP TABLE IF EXISTS _latest_ids");
}

async function createIdsTable(connection: DuckDBConnection, idsFile: string): Promise<void> {
  await connection.run(
    `CREATE TEMP TABLE _latest_ids AS SELECT * FROM read_json_auto(${sqlString(idsFile)}, maximum_object_size=${MAXIMUM_OBJECT_SIZE}, union_by_name=true)`,
  );
}

async function duckDbTableExists(
  connection: DuckDBConnection,
  tableName: string,
): Promise<boolean> {
  const reader = await connection.runAndReadAll(
    `SELECT count(*)::INTEGER AS count
     FROM information_schema.tables
     WHERE table_schema = 'main'
       AND table_name = ${sqlString(tableName)}`,
  );
  const row = reader.getRowObjects()[0];
  return Number(row?.count ?? 0) > 0;
}

async function duckDbRowCount(connection: DuckDBConnection, tableName: string): Promise<number> {
  const reader = await connection.runAndReadAll(
    `SELECT count(*)::INTEGER AS count FROM ${sqlIdentifier(tableName)}`,
  );
  const row = reader.getRowObjects()[0];
  return Number(row?.count ?? 0);
}

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(
    path,
    rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function createWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "livemarks-delta-"));
}

function safeFileStem(value: string): string {
  return basename(value).replace(/[^A-Za-z0-9_.-]/g, "_") || "collection";
}

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
