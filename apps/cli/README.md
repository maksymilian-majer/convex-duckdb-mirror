# convex-duckdb-sync

CLI client for syncing Convex data into a local DuckDB database through a Convex DuckDB proxy.

```bash
npx convex-duckdb-sync install
npx convex-duckdb-sync status
npx convex-duckdb-sync refresh
npx convex-duckdb-sync refresh --full
```

## Config

The CLI reads only:

```text
.convex-duckdb/config.json
```

Create it with:

```bash
npx convex-duckdb-sync install
```

Required keys:

| Key | Purpose |
| --- | --- |
| `CONVEX_DUCKDB_PROXY_URL` | Mirror proxy URL |
| `CONVEX_DUCKDB_ACCESS_TOKEN` | Bearer token for mirror data routes |

The CLI does not load environment variables or `.env` files.

## Sync behavior

1. Incremental sync fetches document deltas from `/api/document_deltas`.
2. Full restore downloads collection snapshots through `/api/json_schemas` and `/api/list_snapshot`, then builds `.convex-duckdb/data.duckdb`.
3. If the mirror retention window expired, refresh performs a full restore automatically.

Query with the DuckDB CLI:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SELECT count(*) FROM table_name;"
```

See the root README for proxy setup and `skills/convex-duckdb-sync` for reusable agent query patterns.
