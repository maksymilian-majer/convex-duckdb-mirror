# Convex DuckDB Mirror

Give your AI agents a fast, local, read-only copy of your Convex data to run SQL against. DuckDB answers analytical queries in ~50–100 ms even over multi-gigabyte dumps, so an agent can tirelessly explore counts, joins, aggregates, and trends across your app's tables — without touching your live Convex deployment.

It has two halves: a **proxy** you deploy once (e.g. on Railway) that holds your Convex deploy key and buffers data, and a **CLI** you run wherever you want the DuckDB file. The Convex deploy key never leaves the server — the CLI only ever talks to the proxy.

## Quickstart — deploy on Railway in ~5 minutes

This is the fast path: deploy the proxy, point the CLI at it, sync, and hand it to your agent. You don't need to clone this repo.

Use the tested Railway template for the shortest setup path:

```text
https://railway.com/deploy/p-a9bt
```

The template provisions the proxy service, a volume for the SQLite buffer, and a generated `CONVEX_DUCKDB_ACCESS_TOKEN`. After deployment, add your Convex deployment URL and deploy key, then use the generated access token when configuring the CLI.

### 1. Deploy the proxy to Railway

Deploy the Railway template above, or create a Railway service from this repo manually (it builds and starts from [`railway.toml`](railway.toml)). If deploying manually, **add a volume** for the SQLite buffer. Set these variables:

| Variable | Where it comes from |
| --- | --- |
| `SYNC_CONVEX_DEPLOY_KEY` | A Convex **production** deploy key — see below |
| `NEXT_PUBLIC_CONVEX_URL` | Convex dashboard → [Settings → URL and Deploy Key](https://docs.convex.dev/dashboard/deployments/deployment-settings) (your deployment URL) |
| `CONVEX_DUCKDB_ACCESS_TOKEN` | A shared secret for the CLI. The Railway template generates this for you; look it up in the Railway dashboard. For a manual deploy, set your own, e.g. `openssl rand -hex 32` |
| `CONVEX_DUCKDB_PROXY_DATA_DIR` | Path on the mounted volume, e.g. `/data/convex-duckdb-proxy` |

**Getting the deploy key.** Either copy a production deploy key from the Convex dashboard ([Settings → URL and Deploy Key](https://docs.convex.dev/dashboard/deployments/deployment-settings)), or mint one from the [Convex CLI](https://docs.convex.dev/cli/deploy-key-types) (often quicker):

```bash
npx convex deployment token create convex-duckdb-proxy --deployment prod
```

Run it from your Convex project while logged in (`npx convex login`), and not with `CONVEX_DEPLOY_KEY` already in your environment. Paste the printed key into Railway as `SYNC_CONVEX_DEPLOY_KEY`.

Railway provides the public URL and injects `PORT` automatically. When the service is up, note its public URL and the value of `CONVEX_DUCKDB_ACCESS_TOKEN`.

### 2. Point the CLI at the proxy

From the repository where you want the local DuckDB file:

```bash
npx convex-duckdb install
```

`install` is interactive and writes `.convex-duckdb/config.json`. Give it:

- **Proxy URL** — your Railway service's public URL
- **Access token** — the same `CONVEX_DUCKDB_ACCESS_TOKEN` value from the Railway dashboard

The CLI reads **only** `.convex-duckdb/config.json` — never environment variables or `.env` files.

> Before the npm package is published, replace `convex-duckdb` with the GitHub form, e.g. `npx maksymilian-majer/convex-duckdb-mirror install`.

### 3. Sync and query

```bash
npx convex-duckdb status
npx convex-duckdb sync          # incremental; full restore on first run or after retention expiry
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

`.convex-duckdb/data.duckdb` now holds your tables. The very first `sync` does a full restore via the snapshot routes, so it works immediately on a freshly deployed proxy; you don't have to wait for the delta buffer to warm up. Use `npx convex-duckdb sync --full` to force a fresh full restore.

### 4. Hand it to your AI agent

This is the real payoff. Install the skill into your agent:

```bash
npx skills add maksymilian-majer/convex-duckdb-mirror
```

Now your agent can keep the mirror in sync and write SQL against it directly. See [Agent analytics](#agent-analytics).

## Agent analytics

This is what the mirror is for. With the skill installed, an agent treats `.convex-duckdb/data.duckdb` as a read-only analytics database: it checks sync status, refreshes when stale, and writes SQL directly. DuckDB's speed (~50–100 ms on multi-GB files) means the agent can iterate freely — exploring, aggregating, and joining — without hammering your live Convex deployment.

For example, top authors by bookmarked tweets:

```sql
SELECT userScreenName, count(*) AS bookmarks
FROM tweets
WHERE isBookmarked
GROUP BY 1
ORDER BY bookmarks DESC
LIMIT 10;
```

A scan-and-group aggregate like this would take tens of seconds — even minutes — against Convex, but returns in ~50 ms from the DuckDB mirror.

To write correct queries, an agent should:

1. **Read intent from your Convex schema** — usually `convex/schema.ts` — to learn table names, fields, and relationships.
2. **Confirm the real columns and types** with `DESCRIBE <table>`, because the mirror infers DuckDB types from the exported data rather than from the schema.
3. **Cast where needed** (e.g. millisecond timestamps via `epoch_ms(field::bigint)`).

How Convex maps to DuckDB, in short: each Convex collection becomes a DuckDB table of the same name; documents become rows; `_id` is the `VARCHAR` key used for joins (`child.parentId = parent._id`), alongside system columns `_creationTime` and `_component`; optional fields become nullable columns; nested objects become `STRUCT`s and arrays of objects become `STRUCT(...)[]` or `JSON[]`. Types are inferred, so always `DESCRIBE` before relying on a column's type. The full conventions and reusable query patterns live in [`skills/convex-duckdb`](skills/convex-duckdb/SKILL.md).

## Why this exists

This project was spun out of building [Livemarks.io](https://livemarks.io), a data-heavy, engineering-heavy project where AI agents had to stay grounded in production data to make progress and iterate quickly.

Convex's official path to external analytics is its streaming-export API feeding general-purpose connectors like Fivetran and Airbyte into a data warehouse. That's powerful but heavy: multiple sinks, accounts, and operational overhead for a use case that often just needs *some* fast SQL.

This project is the opposite — narrow on purpose:

- **One sink: DuckDB.** No warehouse, no connector platform.
- **Operationally lightweight.** A single small proxy plus a CLI.
- **Opinionated and agent-first.** Built so AI agents can poke at your app's data and get answers in milliseconds.

It's built on the same Convex streaming-export endpoints those connectors use. That API is currently beta, so its endpoints and formats can change.

## How it works

### Why two halves?

The proxy exists to make delta sync **reliable and fast**.

Convex's streaming-export delta window is short and outside our control: step away for a weekend and the deltas you need may no longer be served, so the sync simply fails. Convex's export APIs are also slow. The proxy continuously polls Convex and accumulates deltas in a local SQLite buffer (default 168 hours), then serves them back quickly.

Snapshots are the opposite case, so the proxy just **passes them through** without storing anything. They're large, rarely requested (first sync, retention-expiry fallback, `--full`), and a slightly stale snapshot is low value — when you need one, you want the latest.

Routing everything through one service keeps the model simple: the CLI talks to a single proxy with a single token, and the Convex deploy key never leaves the server.

```
Convex deployment
       │   proxy polls deltas; holds the deploy key
       ▼
convex-duckdb-proxy ── GET /api/document_deltas   buffered in local SQLite, extended retention
   (Railway)        ── GET /api/list_snapshot      pass-through, not stored
       │            ── GET /api/json_schemas       pass-through, not stored
       ▼
convex-duckdb CLI  ──►  .convex-duckdb/data.duckdb
   (your machine)
```

### The two packages

| Package | Path | Role |
| --- | --- | --- |
| `convex-duckdb` | [`apps/cli`](apps/cli) | Local CLI. Writes `.convex-duckdb/config.json` and syncs `.convex-duckdb/data.duckdb`. Talks only to the proxy. |
| `convex-duckdb-proxy` | [`apps/proxy`](apps/proxy) | Long-lived service. Holds the Convex deploy key, buffers document deltas in SQLite, and pass-through proxies snapshot routes. |

### Streaming-export API

The mirror implements a subset of [Convex streaming export](https://docs.convex.dev/production/integrations/streaming-import-export):

| Endpoint | Proxy behavior | CLI uses it for |
| --- | --- | --- |
| `GET /api/json_schemas` | pass-through | full restore |
| `GET /api/list_snapshot` | pass-through | full restore |
| `GET /api/document_deltas` | buffered and served | incremental sync |

Pass-through routes forward the upstream response body unchanged, preserving nanosecond snapshot/cursor values. The proxy also exposes `/health` and `/status` for ops. `/status` reports `ready: true` only when deltas are buffered, the access token is configured, and snapshot pass-through is wired. If a `cursor` is older than the retention window, the proxy returns Convex-compatible `InvalidWindowToReadDocuments`, and the CLI full-restores instead of retrying.

## Configuration reference

### Proxy (environment variables)

Set these where the proxy runs — Railway service variables in production, or `apps/proxy/.env.local` for local development (see [Local development](#local-development)).

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SYNC_CONVEX_DEPLOY_KEY` | yes | — | Server-only. Used to poll Convex. Never sent to clients. |
| `NEXT_PUBLIC_CONVEX_URL` | yes | — | Convex deployment URL. |
| `CONVEX_DUCKDB_ACCESS_TOKEN` | yes | — | Bearer token for mirror data routes. Must match the CLI's token. |
| `CONVEX_DUCKDB_PROXY_DATA_DIR` | recommended | `apps/proxy/data` | SQLite buffer location; point at a mounted volume in production. Deprecated alias: `DELTAS_PROXY_DATA_DIR`. |
| `PORT` | no | `3002` | HTTP port. Railway sets this automatically. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `DELTA_RETENTION_HOURS` | no | `168` | How long deltas are buffered (7 days). |
| `DELTA_POLL_INTERVAL_SECONDS` | no | `30` | Convex poll interval. |
| `DOCUMENT_DELTAS_PAGE_SIZE` | no | `128` | Delta page size. |

### CLI (config file, not env vars)

`npx convex-duckdb install` writes these into `.convex-duckdb/config.json`. The CLI does not read environment variables.

| Key | Required | Notes |
| --- | --- | --- |
| `CONVEX_DUCKDB_PROXY_URL` | yes | URL of the deployed or local proxy. |
| `CONVEX_DUCKDB_ACCESS_TOKEN` | yes | Bearer token; must equal the proxy's `CONVEX_DUCKDB_ACCESS_TOKEN`. |

## Local development

For running the proxy on your own machine and hacking on the code. End users following the [Quickstart](#quickstart--deploy-on-railway-in-5-minutes) don't need any of this.

```bash
npm install
npm run build
npm test
npm pack --workspace convex-duckdb
```

Run the proxy locally:

```bash
cp apps/proxy/.env.local.example apps/proxy/.env.local   # then fill it in
npm run proxy:dev                                         # server + poller on :3002
```

The proxy runs as two Node processes (Node 24+) sharing one SQLite database in WAL mode:

| Process | Entry | Role |
| --- | --- | --- |
| HTTP server | `apps/proxy/dist/server.js` | `/health`, `/status`, mirror data routes |
| Poller | `apps/proxy/dist/pollerMain.js` | Polls Convex and appends deltas |

`npm run proxy:dev` starts both.

### Localhost smoke test

Use this before testing against a remote proxy. With the local proxy running, configure the CLI against it (`CONVEX_DUCKDB_PROXY_URL=http://127.0.0.1:3002`, `CONVEX_DUCKDB_ACCESS_TOKEN=<same token as apps/proxy/.env.local>`):

```bash
npx convex-duckdb install
npx convex-duckdb status --json
npx convex-duckdb sync --json
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

You can also hit the proxy directly:

```bash
curl -i http://127.0.0.1:3002/health
curl -i http://127.0.0.1:3002/status
curl -i -H "Authorization: Bearer $CONVEX_DUCKDB_ACCESS_TOKEN" \
  "http://127.0.0.1:3002/api/json_schemas?format=json"
```

## Publishing the CLI

The `convex-duckdb` package is published by [`.github/workflows/npm-publish.yml`](.github/workflows/npm-publish.yml) when a GitHub release is published, or manually via `workflow_dispatch`. It publishes the `apps/cli` workspace and requires no `NPM_TOKEN`.

Configure npm trusted publishing for the package before the first run:

```text
Provider: GitHub Actions
Repository: maksymilian-majer/convex-duckdb-mirror
Workflow: npm-publish.yml
Environment: empty
```
