import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type JsonRecord, stringifyConvexJson } from "./convexJson.js";

export interface ProxyState {
  latestCursor: bigint | null;
  oldestCursor: bigint | null;
  lastPollAt: string | null;
  lastEventAt: string | null;
  lastError: { at: string; message: string } | null;
}

export interface PageFromStore {
  body: string;
  cursor: bigint;
  hasMore: boolean;
  timings: {
    sqlMs: number;
    jsonMs: number;
    rowCount: number;
  };
}

interface StateRow {
  latest_cursor: bigint | null;
  oldest_cursor: bigint | null;
  last_poll_at: string | null;
  last_event_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
}

interface DeltaPageRow {
  boundary_ts: bigint;
  has_more: bigint | number;
  row_json: string;
}

interface MinTsRow {
  min_ts: bigint | null;
}

const DEFAULT_STATE: ProxyState = {
  latestCursor: null,
  oldestCursor: null,
  lastPollAt: null,
  lastEventAt: null,
  lastError: null,
};

export function databasePath(dataDir: string): string {
  return join(dataDir, "deltas.sqlite");
}

interface OpenDeltasStoreOptions {
  createIfMissing?: boolean;
}

export class DeltasStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dataDir: string, options: OpenDeltasStoreOptions = {}): DeltasStore {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = databasePath(dataDir);
    if (options.createIfMissing === false && !existsSync(dbPath)) {
      throw new Error(`SQLite deltas database does not exist: ${dbPath}`);
    }
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        latest_cursor INTEGER,
        oldest_cursor INTEGER,
        last_poll_at TEXT,
        last_event_at TEXT,
        last_error_at TEXT,
        last_error_message TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS deltas (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        received_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS deltas_ts_id_idx
        ON deltas(ts, id);

      CREATE INDEX IF NOT EXISTS deltas_table_ts_id_idx
        ON deltas(table_name, ts, id);
    `);
    return new DeltasStore(db);
  }

  close(): void {
    this.db.close();
  }

  readState(): ProxyState {
    const statement = this.db.prepare(`
      SELECT latest_cursor, oldest_cursor, last_poll_at, last_event_at, last_error_at, last_error_message
      FROM proxy_state
      WHERE id = 1
    `);
    statement.setReadBigInts(true);
    const row = statement.get() as unknown as StateRow | undefined;
    if (!row) return { ...DEFAULT_STATE };
    return {
      latestCursor: row.latest_cursor,
      oldestCursor: row.oldest_cursor,
      lastPollAt: row.last_poll_at,
      lastEventAt: row.last_event_at,
      lastError:
        row.last_error_at !== null && row.last_error_message !== null
          ? { at: row.last_error_at, message: row.last_error_message }
          : null,
    };
  }

  writeState(state: ProxyState): void {
    this.db
      .prepare(`
        INSERT INTO proxy_state (
          id,
          latest_cursor,
          oldest_cursor,
          last_poll_at,
          last_event_at,
          last_error_at,
          last_error_message
        )
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          latest_cursor = excluded.latest_cursor,
          oldest_cursor = excluded.oldest_cursor,
          last_poll_at = excluded.last_poll_at,
          last_event_at = excluded.last_event_at,
          last_error_at = excluded.last_error_at,
          last_error_message = excluded.last_error_message
      `)
      .run(
        state.latestCursor,
        state.oldestCursor,
        state.lastPollAt,
        state.lastEventAt,
        state.lastError?.at ?? null,
        state.lastError?.message ?? null,
      );
  }

  appendDeltas(rows: JsonRecord[], receivedAt: string): void {
    if (rows.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO deltas (ts, table_name, received_at, row_json)
      VALUES (?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const row of rows) {
        insert.run(row._ts as bigint, row._table as string, receivedAt, stringifyConvexJson(row));
      }
    });
  }

  removeDeltasOlderThanRetentionPeriod(
    retentionHours: number,
    fallbackOldestCursor: bigint,
  ): bigint | null {
    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
    let removedUntilTs: bigint | null = null;

    this.transaction(() => {
      const result = this.db.prepare("DELETE FROM deltas WHERE received_at < ?").run(cutoff);
      if (result.changes === 0) return;

      const statement = this.db.prepare("SELECT MIN(ts) AS min_ts FROM deltas");
      statement.setReadBigInts(true);
      const row = statement.get() as unknown as MinTsRow | undefined;
      removedUntilTs = row?.min_ts ?? fallbackOldestCursor;
    });

    return removedUntilTs;
  }

  pageDeltas(
    cursor: bigint,
    latestCursor: bigint,
    pageSize: number,
    tableName?: string,
  ): PageFromStore {
    const sqlStartedAt = performance.now();
    const rows = this.selectPageRows(cursor, latestCursor, pageSize, tableName);
    const sqlMs = performance.now() - sqlStartedAt;
    if (rows.length === 0) {
      return {
        body: buildDocumentDeltasResponse([], latestCursor, false),
        cursor: latestCursor,
        hasMore: false,
        timings: { sqlMs, jsonMs: 0, rowCount: 0 },
      };
    }

    const [firstRow] = rows;
    const boundaryTs = firstRow.boundary_ts;
    const hasMore = firstRow.has_more !== 0 && firstRow.has_more !== 0n;
    const responseCursor = hasMore ? boundaryTs : latestCursor;
    const jsonStartedAt = performance.now();
    const body = buildDocumentDeltasResponse(
      rows.map((row) => row.row_json),
      responseCursor,
      hasMore,
    );
    const jsonMs = performance.now() - jsonStartedAt;
    return {
      body,
      cursor: responseCursor,
      hasMore,
      timings: { sqlMs, jsonMs, rowCount: rows.length },
    };
  }

  private selectPageRows(
    cursor: bigint,
    latestCursor: bigint,
    pageSize: number,
    tableName?: string,
  ): DeltaPageRow[] {
    const limit = Math.max(1, pageSize);
    const statement = this.db.prepare(
      tableName === undefined
        ? `
          SELECT
            d.row_json,
            boundary.boundary_ts,
            EXISTS (
              SELECT 1
              FROM deltas h
              WHERE h.ts > boundary.boundary_ts
                AND h.ts <= ?
              LIMIT 1
            ) AS has_more
          FROM (
            SELECT max(ts) AS boundary_ts
            FROM (
              SELECT ts
              FROM deltas
              WHERE ts > ?
                AND ts <= ?
              ORDER BY ts, id
              LIMIT ?
            )
          ) boundary
          JOIN deltas d
            ON d.ts > ?
           AND d.ts <= boundary.boundary_ts
          WHERE boundary.boundary_ts IS NOT NULL
          ORDER BY d.ts, d.id
        `
        : `
          SELECT
            d.row_json,
            boundary.boundary_ts,
            EXISTS (
              SELECT 1
              FROM deltas h
              WHERE h.table_name = ?
                AND h.ts > boundary.boundary_ts
                AND h.ts <= ?
              LIMIT 1
            ) AS has_more
          FROM (
            SELECT max(ts) AS boundary_ts
            FROM (
              SELECT ts
              FROM deltas
              WHERE table_name = ?
                AND ts > ?
                AND ts <= ?
              ORDER BY ts, id
              LIMIT ?
            )
          ) boundary
          JOIN deltas d
            ON d.table_name = ?
           AND d.ts > ?
           AND d.ts <= boundary.boundary_ts
          WHERE boundary.boundary_ts IS NOT NULL
          ORDER BY d.ts, d.id
        `,
    );
    statement.setReadBigInts(true);
    return (tableName === undefined
      ? statement.all(latestCursor, cursor, latestCursor, limit, cursor)
      : statement.all(
          tableName,
          latestCursor,
          tableName,
          cursor,
          latestCursor,
          limit,
          tableName,
          cursor,
        )) as unknown as DeltaPageRow[];
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function buildDocumentDeltasResponse(
  rowJsonValues: string[],
  cursor: bigint,
  hasMore: boolean,
): string {
  return `{"values":[${rowJsonValues.join(",")}],"cursor":${cursor.toString()},"hasMore":${hasMore ? "true" : "false"}}`;
}

export function openDeltasStore(dataDir: string): DeltasStore {
  return DeltasStore.open(dataDir);
}

export function openExistingDeltasStore(dataDir: string): DeltasStore {
  return DeltasStore.open(dataDir, { createIfMissing: false });
}
