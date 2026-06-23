import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MAXIMUM_OBJECT_SIZE } from "./applySnapshotDeltas.js";

/**
 * List the collection table names backed by `<collection>.jsonl` files in a
 * flat snapshot directory. Skips internal files (leading `_`) and sorts.
 */
export function listSnapshotTables(snapshotDir: string): string[] {
  if (!existsSync(snapshotDir)) return [];
  return readdirSync(snapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name.slice(0, -".jsonl".length))
    .filter((name) => name.length > 0 && !name.startsWith("_"))
    .sort();
}

/**
 * Build a fresh DuckDB database from a directory of flat `<collection>.jsonl`
 * snapshot files using the DuckDB node-api (no `duckdb` CLI). The database is
 * built into a temp path and atomically swapped into `duckdbPath` on success.
 *
 * Empty collection files are materialized as a `(_id VARCHAR)` stub; the first
 * delta upsert into such a table replaces the stub with the full schema (see
 * the DuckDB delta apply empty-table handling).
 *
 * Returns the list of table names created.
 */
export async function buildDuckdbFromSnapshot(
  snapshotDir: string,
  duckdbPath: string,
): Promise<string[]> {
  const tables = listSnapshotTables(snapshotDir);
  if (tables.length === 0) {
    throw new Error(
      `No flat JSONL snapshot files found in ${snapshotDir}. Run: npx convex-duckdb sync`,
    );
  }

  mkdirSync(dirname(duckdbPath), { recursive: true });
  const tempDb = `${duckdbPath}.tmp-${process.pid}-${Date.now()}`;
  removeDuckdbFiles(tempDb);

  const instance = await DuckDBInstance.create(tempDb);
  const connection = await instance.connect();
  try {
    for (const table of tables) {
      const jsonl = join(snapshotDir, `${table}.jsonl`);
      if (statSync(jsonl).size === 0) {
        await connection.run(`CREATE TABLE ${sqlIdentifier(table)} (_id VARCHAR)`);
        continue;
      }
      await connection.run(
        `CREATE TABLE ${sqlIdentifier(table)} AS SELECT * FROM read_json_auto(${sqlString(
          jsonl,
        )}, maximum_object_size=${MAXIMUM_OBJECT_SIZE}, union_by_name=true)`,
      );
    }
  } catch (error) {
    connection.disconnectSync();
    instance.closeSync();
    removeDuckdbFiles(tempDb);
    throw error;
  }

  connection.disconnectSync();
  instance.closeSync();

  removeDuckdbFiles(duckdbPath);
  renameSync(tempDb, duckdbPath);
  return tables;
}

/**
 * Return `count(*)` per table from an existing DuckDB, sorted by row count
 * descending. Uses the node-api; no `duckdb` CLI dependency.
 */
export async function tableRowCounts(
  duckdbPath: string,
  tables: string[],
): Promise<Array<{ name: string; rows: number }>> {
  if (tables.length === 0) return [];

  const instance = await DuckDBInstance.create(duckdbPath);
  const connection = await instance.connect();
  try {
    const counts: Array<{ name: string; rows: number }> = [];
    for (const table of tables) {
      const reader = await connection.runAndReadAll(
        `SELECT count(*)::INTEGER AS rows FROM ${sqlIdentifier(table)}`,
      );
      const row = reader.getRowObjects()[0];
      counts.push({ name: table, rows: Number(row?.rows ?? 0) });
    }
    return counts.sort((a, b) => b.rows - a.rows);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

export async function listDuckdbTables(duckdbPath: string): Promise<string[]> {
  if (!existsSync(duckdbPath)) return [];

  const instance = await DuckDBInstance.create(duckdbPath);
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'main'
      ORDER BY table_name
    `);
    return reader
      .getRowObjects()
      .map((row) => String(row.table_name ?? ""))
      .filter((table) => table.length > 0);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

function removeDuckdbFiles(duckdbPath: string): void {
  rmSync(duckdbPath, { force: true });
  rmSync(`${duckdbPath}.wal`, { force: true });
}

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
