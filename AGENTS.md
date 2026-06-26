# AGENTS.md

Instructions for AI coding agents working on Convex DuckDB Mirror.

Format: [agents.md](https://agents.md)

## Project overview

Convex DuckDB Mirror gives agents and developers a fast local DuckDB copy of Convex data for read-only analytical SQL.

This is an npm workspace monorepo with two packages:

- `apps/cli` - public CLI package `convex-duckdb`. Writes `.convex-duckdb/config.json`, syncs `.convex-duckdb/data.duckdb`, and talks only to the proxy.
- `apps/proxy` - private Railway-deployed service package `convex-duckdb-proxy`. Holds the Convex deploy key, buffers document deltas in SQLite, and passes snapshot routes through to Convex.

The proxy is the only place that uses Convex deploy credentials. The CLI must never read Convex deploy keys or `.env` files.

## Dev environment

- Package manager: `npm`
- Runtime: Node.js 24+
- Install: `npm install`
- Workspaces: `apps/*`
- Local CLI config: `.convex-duckdb/config.json` in the consumer repo. Never commit it.
- Proxy local env: `apps/proxy/.env.local`. Never commit it.
- Proxy local data: `apps/proxy/data/`. Never commit it.

## Key commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build CLI and proxy |
| `npm test` | Run CLI and proxy tests |
| `npm run cli:build` | Build the CLI workspace |
| `npm run cli:test` | Run CLI tests |
| `npm run proxy:build` | Build the proxy workspace |
| `npm run proxy:test` | Run proxy tests |
| `npm run proxy:dev` | Run local proxy server and poller on `http://127.0.0.1:3002` |
| `npm run proxy:start` | Run built proxy server and poller |
| `npm pack --workspace convex-duckdb` | Inspect the publish tarball locally |

End-user CLI commands:

```bash
npx convex-duckdb install
npx convex-duckdb status
npx convex-duckdb sync
npx convex-duckdb sync --full
```

## Source of truth

- Start with `README.md` for product behavior, setup, environment variables, Railway deployment, local smoke tests, and publishing.
- Use `skills/convex-duckdb/SKILL.md` as the source of truth for how downstream agents should query a synced DuckDB mirror.
- Use package scripts as the source of truth for commands; avoid inventing one-off build or test commands when an npm script exists.
- When external behavior matters, prefer official docs for the relevant service or library. Do not require repo-local tooling that is not committed here.

## CLI behavior

- `convex-duckdb install` is interactive and collects credentials. Do not run it unless the user explicitly asks.
- The CLI reads only `.convex-duckdb/config.json`, not environment variables.
- `convex-duckdb sync` performs incremental sync, full restore on first run, and full restore when proxy retention has expired.
- `convex-duckdb sync --full` forces a clean full restore.
- The first sync should work immediately against a freshly deployed proxy because snapshots are passed through directly.
- Query DuckDB read-only:

```bash
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

## Proxy behavior

- Railway builds with `npm run proxy:build` and starts with `npm run proxy:start` from `railway.toml`.
- The tested Railway template is `https://railway.com/deploy/p-a9bt`; prefer it for end-user deploy guidance unless the user is hacking on this repo directly.
- The proxy runs two Node processes sharing one SQLite DB in WAL mode:
  - `apps/proxy/dist/server.js` - HTTP server for `/health`, `/status`, and mirror data routes.
  - `apps/proxy/dist/pollerMain.js` - Convex delta poller.
- `CONVEX_DUCKDB_PROXY_DATA_DIR` should point at a Railway mounted volume in production.
- On a fresh volume, startup must create the SQLite DB and schema if missing.
- The proxy buffers `GET /api/document_deltas` in SQLite and passes `GET /api/json_schemas` and `GET /api/list_snapshot` through to Convex unchanged.
- `/status` is ready only when deltas are buffered, the data-route access token is configured, and snapshot pass-through is wired.
- Required proxy env vars are documented in `README.md`. `CONVEX_DEPLOY_KEY` must remain server-only and must never be exposed to CLI users.

## Local smoke test

Use this path when changing proxy startup, config, auth, pass-through behavior, or CLI sync behavior:

```bash
cp apps/proxy/.env.local.example apps/proxy/.env.local
npm run proxy:dev
```

Then, from a consumer repo or a scratch directory configured for the local proxy:

```bash
npx convex-duckdb install
npx convex-duckdb status --json
npx convex-duckdb sync --json
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SHOW TABLES;"
```

Do not commit `.env.local`, `.convex-duckdb/`, `apps/proxy/data/`, generated `dist/`, or `.tgz` files.

## Agent analytics skill

The reusable agent skill lives in `skills/convex-duckdb/SKILL.md`. Keep examples and package names in sync with the public CLI:

```bash
npx convex-duckdb status --json
npx convex-duckdb sync
duckdb -readonly .convex-duckdb/data.duckdb -markdown <<< "SELECT count(*) FROM table_name;"
```

For ad-hoc analysis in a consumer repo:

1. Read the consumer app's Convex schema first, usually `convex/schema.ts`.
2. Confirm actual DuckDB columns with `SHOW TABLES` and `DESCRIBE table_name`.
3. Use read-only DuckDB queries for counts, joins, grouping, and trend analysis.
4. Do not mutate `.convex-duckdb/data.duckdb`.

Convex-to-DuckDB mapping:

- Each Convex collection becomes a DuckDB table of the same name.
- Documents become rows; `_id` is the `VARCHAR` key used for joins.
- System fields include `_creationTime` and `_component`.
- Optional fields become nullable columns.
- Nested objects may become `STRUCT`s, and arrays of objects may become `STRUCT(...)[]` or `JSON[]`.
- Types are inferred from exported data, so confirm with `DESCRIBE` before relying on casts.

## Publishing

- The public npm package is `convex-duckdb`.
- Publish workflow: `.github/workflows/npm-publish.yml`.
- Publishing uses npm trusted publishing with GitHub Actions OIDC. Do not add an `NPM_TOKEN` unless the user explicitly changes the publishing model.
- Before publishing, run:

```bash
npm test
npm publish --workspace apps/cli --dry-run --access public
```

- Confirm `npm view convex-duckdb version dist-tags.latest --json` before and after workflow runs.

## Conventions

- Keep changes scoped. Do not refactor the CLI and proxy together unless the task requires it.
- Use structured JSON/parsers where practical instead of ad hoc string manipulation.
- Prefer focused tests for startup, packaging, sync, and proxy route behavior.
- Do not commit generated `dist/`, `.tgz`, `.convex-duckdb/`, proxy data, or local env files.
- Avoid em dashes in user-facing copy.
