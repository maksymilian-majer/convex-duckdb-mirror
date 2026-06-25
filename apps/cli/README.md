# convex-duckdb

`convex-duckdb` keeps a local DuckDB copy of your Convex data in sync so you and your AI agents can run fast, read-only SQL for counts, joins, aggregates, filtering, and exploratory debugging.

The CLI does not talk to Convex directly. It connects to a `convex-duckdb-proxy` service that holds your Convex deploy key, buffers document deltas in SQLite, and passes full snapshot requests through to Convex.

## Quick Start

First deploy the proxy. The fastest path is the tested Railway template:

```text
https://railway.com/deploy/p-a9bt
```

The template provisions the proxy service, a volume for the SQLite delta buffer, and a generated `CONVEX_DUCKDB_ACCESS_TOKEN`. After deployment, add your Convex deployment URL and deploy key in Railway.

Then configure the CLI in the repository where you want the local DuckDB file:

```bash
npx convex-duckdb install
```

`install` is interactive and writes `.convex-duckdb/config.json` with:

- `CONVEX_DUCKDB_PROXY_URL` - your Railway proxy URL
- `CONVEX_DUCKDB_ACCESS_TOKEN` - the token from the Railway deployment

The CLI reads only `.convex-duckdb/config.json`. It never reads environment variables or `.env` files.

## Usage

```bash
npx convex-duckdb status
npx convex-duckdb sync
npx convex-duckdb sync --full
```

The first `sync` performs a full restore through the proxy snapshot routes. Later syncs use buffered document deltas. If the delta retention window has expired, the CLI automatically falls back to a full restore.

Query the synced database with DuckDB:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

Example:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<'SQL'
SELECT table_name, estimated_size
FROM duckdb_tables()
ORDER BY table_name;
SQL
```

## Agent Workflow

Install the reusable skill into supported agents:

```bash
npx skills add maksymilian-majer/convex-duckdb-mirror
```

With the skill installed, agents can:

- check mirror status with `npx convex-duckdb status --json`
- sync data with `npx convex-duckdb sync`
- inspect schemas with DuckDB `SHOW TABLES` and `DESCRIBE`
- run read-only analytical SQL against `.convex-duckdb/data.duckdb`

Agents should read your Convex schema first, usually `convex/schema.ts`, then confirm actual DuckDB columns with `DESCRIBE` because types are inferred from exported data.

## How It Works

The proxy exposes a small subset of Convex streaming export:

- `GET /api/document_deltas` - buffered in proxy SQLite for fast incremental sync
- `GET /api/json_schemas` - passed through to Convex for full restore
- `GET /api/list_snapshot` - passed through to Convex for full restore

The Convex deploy key stays on the proxy. The CLI only needs the proxy URL and access token.

## Links

- Full docs and proxy setup: <https://github.com/maksymilian-majer/convex-duckdb-mirror#readme>
- Railway template: <https://railway.com/deploy/p-a9bt>
- Agent skill: <https://github.com/maksymilian-majer/convex-duckdb-mirror/tree/main/skills/convex-duckdb>
