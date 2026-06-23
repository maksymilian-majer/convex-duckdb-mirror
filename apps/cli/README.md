# convex-duckdb

CLI client for syncing Convex data into a local DuckDB database through a Convex DuckDB proxy.

```bash
npx convex-duckdb install
npx convex-duckdb status
npx convex-duckdb sync
npx convex-duckdb sync --full
```

## Config

`install` writes `.convex-duckdb/config.json`. The CLI reads only that file, not environment variables or `.env` files.

From a consumer repo:

```bash
npx convex-duckdb install
```

Required keys:

| Key | Purpose |
| --- | --- |
| `CONVEX_DUCKDB_PROXY_URL` | Mirror proxy URL |
| `CONVEX_DUCKDB_ACCESS_TOKEN` | Bearer token for mirror data routes |

## How sync works

1. Incremental sync fetches document deltas from `/api/document_deltas`.
2. On first run or after retention expiry, sync performs a full restore from snapshot routes.
3. If the mirror retention window expired, sync performs a full restore automatically.

Query the local database:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

See the root README for proxy setup and `skills/convex-duckdb` for reusable agent query patterns.
