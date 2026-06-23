# convex-duckdb-proxy

HTTP service for Convex DuckDB sync. It polls Convex document deltas into a local SQLite buffer, serves `/api/document_deltas` with extended retention, and pass-through proxies snapshot routes without storing them.

## Commands

From the repo root:

```bash
npm run proxy:dev
npm run proxy:start
npm run proxy:build
npm run proxy:test
```

Workspace equivalent:

```bash
npm --workspace @convex-duckdb-sync/proxy run dev
```

## Process model

Two Node processes share one SQLite database in WAL mode:

| Process | Entry | Role |
| --- | --- | --- |
| HTTP server | `dist/server.js` | `/health`, `/status`, mirror data routes |
| Poller | `dist/pollerMain.js` | Polls Convex and appends deltas |

Requires Node 24+.

## Environment

For local development, copy `apps/proxy/.env.local.example` to `apps/proxy/.env.local`.

```bash
SYNC_CONVEX_DEPLOY_KEY=...
NEXT_PUBLIC_CONVEX_URL=...
CONVEX_DUCKDB_ACCESS_TOKEN=...
```

Optional:

```bash
PORT=3002
HOST=0.0.0.0
CONVEX_DUCKDB_PROXY_DATA_DIR=apps/proxy/data
DELTA_POLL_INTERVAL_SECONDS=30
DELTA_RETENTION_HOURS=168
DOCUMENT_DELTAS_PAGE_SIZE=128
```

`DELTAS_PROXY_DATA_DIR` is a deprecated alias for `CONVEX_DUCKDB_PROXY_DATA_DIR`.

## Endpoints

```bash
curl -i http://127.0.0.1:3002/health
curl -i http://127.0.0.1:3002/status
curl -i -H "Authorization: Bearer $CONVEX_DUCKDB_ACCESS_TOKEN" \
  "http://127.0.0.1:3002/api/json_schemas?format=json"
curl -i -H "Authorization: Bearer $CONVEX_DUCKDB_ACCESS_TOKEN" \
  "http://127.0.0.1:3002/api/list_snapshot?format=json&tableName=tweets"
curl -i -H "Authorization: Bearer $CONVEX_DUCKDB_ACCESS_TOKEN" \
  "http://127.0.0.1:3002/api/document_deltas?format=json&cursor=100"
```

`/status` reports whether the mirror can serve sync clients. `ready` is true only when deltas are buffered, `CONVEX_DUCKDB_ACCESS_TOKEN` is configured, and snapshot pass-through is wired.

If `cursor` is older than the local retention window, the proxy returns Convex-compatible `InvalidWindowToReadDocuments`. Clients should full-restore instead of retrying.

## Railway

Deploy from the repo root using `railway.toml`. Mount a volume and set:

```bash
CONVEX_DUCKDB_PROXY_DATA_DIR=/data/convex-duckdb-proxy
SYNC_CONVEX_DEPLOY_KEY=...
NEXT_PUBLIC_CONVEX_URL=...
CONVEX_DUCKDB_ACCESS_TOKEN=...
```

Railway template publishing is intentionally deferred.
