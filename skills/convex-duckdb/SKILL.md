---
name: convex-duckdb
description: Sync a local DuckDB mirror of Convex data and use it for ad-hoc analytical SQL queries. Use for counts, joins, aggregates, filtering, grouping, time-series analysis, and any query that needs multiple rows or tables.
---

# Convex DuckDB

Use the Convex DuckDB mirror for analytical queries over Convex data. Prefer DuckDB for counts, joins, grouping, filtering across rows, and trend analysis. Use Convex tools only for single-document lookups or mutations.

## Workflow

Use `duckdb -readonly` for ad-hoc queries. Avoid non-readonly DuckDB CLI queries against `.convex-duckdb/data.duckdb`; parallel non-readonly processes can fail on DuckDB file locks. When running several related schema checks or queries, prefer one `duckdb -readonly ... <<'SQL'` heredoc with multiple SQL statements so the output stays grouped and easy to inspect.

1. Check status:

```bash
npx convex-duckdb status --json
```

If config is missing or invalid, ask the user to run:

```bash
npx convex-duckdb install
```

Do not run `install` yourself unless the user explicitly asks you to. It collects credentials.

If `duckdb` is missing, ask the user to install the DuckDB CLI on `PATH`. Never install DuckDB for the user.

2. Sync when needed:

```bash
npx convex-duckdb sync
```

Use a full sync only when the local database is corrupt, schema changed in a way deltas cannot repair, or the user asks for a clean baseline:

```bash
npx convex-duckdb sync --full
```

3. Inspect schema before querying.

Prefer the project Convex schema when available, commonly under `convex/schema.ts` or an app-specific `convex/schema.ts`. If the schema path is unclear or stale, inspect DuckDB directly:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<'SQL'
SHOW TABLES;
DESCRIBE table_name;
SQL
```

4. Query with DuckDB:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SELECT count(*) AS rows FROM table_name;"
```

## How Convex maps to DuckDB

The mirror loads Convex's exported documents straight into DuckDB and lets DuckDB infer the schema, so column types are emergent rather than declared. Read `convex/schema.ts` for intent (table names, relationships, which fields exist), then reconcile against `DESCRIBE <table>` for the actual DuckDB columns and types before relying on them. Types can vary by deployment, so always `DESCRIBE`.

- Each Convex collection becomes a DuckDB table with the same name; each document is a row.
- Every table has system columns: `_id` (`VARCHAR`, the key), `_creationTime` (`DOUBLE`, ms since epoch), and `_component` (`VARCHAR`).
- Relationships: `v.id(...)` fields are `VARCHAR`. Join via ids: `child.parentId = parent._id`.
- Scalars: `v.string()` → `VARCHAR`; `v.boolean()` → `BOOLEAN`; integer `v.number()` → `BIGINT`; `v.array(v.float64())` → `DOUBLE[]`.
- Timestamps: app millisecond fields (e.g. `createdAt`) are usually `BIGINT`, so `epoch_ms(createdAt)`. `_creationTime` is `DOUBLE`, so `epoch_ms(_creationTime::bigint)`. ISO-8601 date strings may be inferred as `TIMESTAMP`.
- Optional fields become nullable columns. A field absent from every synced row may not exist as a column at all — never assume an optional field is present; check with `DESCRIBE`.
- Nested objects and object-unions become `STRUCT`s (union branches are merged; absent branch fields are NULL). Access with dot notation, e.g. `col.field`.
- Arrays of objects land as either `STRUCT(...)[]` (use `UNNEST`) or `JSON[]` when row shapes are irregular (use JSON functions like `->>`). Both occur — check the column type first. `v.any()` is likewise inferred per data and may be a `STRUCT` or `JSON`.
- Column order is not schema order, and delta-introduced columns are appended later — reference columns by name, never by position.
- A collection that was empty at snapshot time may appear as a stub table with only `(_id VARCHAR)` until its first row syncs.

## Query Patterns

Join by Convex document IDs:

```sql
SELECT a._id, b.relatedField
FROM table_a a
JOIN table_b b ON b.tableAId = a._id
LIMIT 20;
```

Count by a category:

```sql
SELECT category_field, count(*) AS rows
FROM table_name
GROUP BY 1
ORDER BY rows DESC
LIMIT 20;
```

Analyze timestamps stored as Unix milliseconds:

```sql
SELECT date_trunc('day', epoch_ms(createdAt::bigint)) AS day, count(*) AS rows
FROM table_name
GROUP BY 1
ORDER BY 1;
```

## Notes

- The local database path is `.convex-duckdb/data.duckdb`.
- Local config and data under `.convex-duckdb/` are gitignored.
- The sync uses the Node DuckDB library. The `duckdb` CLI is only needed for ad-hoc querying.
- When status reports an active sync, wait for it to finish. Use `sync --force` only when the lock is clearly orphaned.
