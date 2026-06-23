# Convex DuckDB Sync

Sync Convex data into a local DuckDB database for ad-hoc analytics.

This repo contains two pieces:

| Package | Path | Role |
| --- | --- | --- |
| `convex-duckdb-sync` | `apps/cli` | Local CLI. Writes `.convex-duckdb/config.json` and refreshes `.convex-duckdb/data.duckdb`. |
| `@convex-duckdb-sync/proxy` | `apps/proxy` | Deployable proxy. Polls Convex document deltas and pass-through proxies full snapshot routes. |

## CLI

Run from the repository where you want the local DuckDB file:

```bash
npx convex-duckdb-sync install
npx convex-duckdb-sync status
npx convex-duckdb-sync refresh
```

Before the npm package is published, use the GitHub repo directly:

```bash
npx maksymilian-majer/convex-duckdb-mirror install
npx maksymilian-majer/convex-duckdb-mirror status
npx maksymilian-majer/convex-duckdb-mirror refresh
```

`install` writes `.convex-duckdb/config.json`. The CLI reads only that file, not environment variables or `.env` files.

Required config values:

| Key | Purpose |
| --- | --- |
| `CONVEX_DUCKDB_PROXY_URL` | URL of the deployed or local proxy |
| `CONVEX_DUCKDB_ACCESS_TOKEN` | Bearer token for proxy data routes |

Query the local database with the DuckDB CLI:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

## Agent Skill

Install the skill into supported agents with:

```bash
npx skills add maksymilian-majer/convex-duckdb-mirror
```

After config exists, agents should use `npx convex-duckdb-sync status`, refresh when needed, then query `.convex-duckdb/data.duckdb` with `duckdb -readonly`.

## Localhost Proxy Smoke Test

Use this before testing a remote proxy.

1. Copy proxy env settings in this repo:

```bash
cp apps/proxy/.env.local.example apps/proxy/.env.local
```

Fill in:

```text
SYNC_CONVEX_DEPLOY_KEY=...
NEXT_PUBLIC_CONVEX_URL=...
CONVEX_DUCKDB_ACCESS_TOKEN=...
CONVEX_DUCKDB_PROXY_DATA_DIR=apps/proxy/data
```

2. Start the local proxy:

```bash
npm run proxy:dev
```

3. In the consumer repo, install the skill:

```bash
npx skills add maksymilian-majer/convex-duckdb-mirror
```

4. In the consumer repo, configure the CLI:

```bash
npx convex-duckdb-sync install
```

Use:

```text
CONVEX_DUCKDB_PROXY_URL=http://127.0.0.1:3002
CONVEX_DUCKDB_ACCESS_TOKEN=<same token as apps/proxy/.env.local>
```

5. Run:

```bash
npx convex-duckdb-sync status --json
npx convex-duckdb-sync refresh --json
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

## Development

```bash
npm install
npm run build
npm test
npm pack --workspace convex-duckdb-sync
```

## Publishing

The CLI package is published by `.github/workflows/npm-publish.yml` when a GitHub release is published, or manually with `workflow_dispatch`.

Configure npm trusted publishing for the CLI package before using the workflow:

```text
Provider: GitHub Actions
Repository: maksymilian-majer/convex-duckdb-mirror
Workflow: npm-publish.yml
Environment: empty
```

The workflow publishes the `apps/cli` workspace, so it should keep working if the package is renamed before the next release. It does not require an `NPM_TOKEN`.

The proxy can be deployed manually to Railway from this repo with `railway.toml`. Railway template publishing is intentionally not included yet.
