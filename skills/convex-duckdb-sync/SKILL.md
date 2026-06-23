---
name: convex-duckdb-sync
description: Sync a local DuckDB mirror of Convex data and use it for ad-hoc analytical SQL queries. Use for counts, joins, aggregates, filtering, grouping, time-series analysis, and any query that needs multiple rows or tables.
---

# DuckDB Sync

Use the Convex DuckDB mirror for analytical queries over Convex data. Prefer DuckDB for counts, joins, grouping, filtering across rows, and trend analysis. Use Convex tools only for single-document lookups or mutations.

## Workflow

Use `duckdb -readonly` for ad-hoc queries. Avoid non-readonly DuckDB CLI queries against `.convex-duckdb/data.duckdb`; parallel non-readonly processes can fail on DuckDB file locks. When running several related schema checks or queries, prefer one `duckdb -readonly ... <<'SQL'` heredoc with multiple SQL statements so the output stays grouped and easy to inspect.

1. Check status:

```bash
npx convex-duckdb-sync status --json
```

If config is missing or invalid, ask the user to run:

```bash
npx convex-duckdb-sync install
```

Do not run `install` yourself unless the user explicitly asks you to. It collects credentials.

If `duckdb` is missing, ask the user to install the DuckDB CLI on `PATH`. Never install DuckDB for the user.

2. Refresh when needed:

```bash
npx convex-duckdb-sync refresh
```

Use a full refresh only when the local database is corrupt, schema changed in a way deltas cannot repair, or the user asks for a clean baseline:

```bash
npx convex-duckdb-sync refresh --full
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
- When status reports an active sync, wait for it to finish. Use `refresh --force` only when the lock is clearly orphaned.
