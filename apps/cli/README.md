# convex-duckdb

CLI that keeps a local DuckDB copy of your Convex data in sync, for fast ad-hoc analytics. It talks to a [`convex-duckdb-proxy`](https://github.com/maksymilian-majer/convex-duckdb-mirror) rather than to Convex directly.

```bash
npx convex-duckdb install   # interactive; writes .convex-duckdb/config.json
npx convex-duckdb status
npx convex-duckdb sync       # incremental; full restore on first run or after retention expiry
npx convex-duckdb sync --full
```

Query the result:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

`install` writes `.convex-duckdb/config.json` (proxy URL + access token). The CLI reads only that file — never environment variables or `.env` files.

Full documentation, including how to run and deploy the proxy, lives in the [project README](https://github.com/maksymilian-majer/convex-duckdb-mirror#readme).
