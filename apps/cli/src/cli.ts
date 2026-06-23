#!/usr/bin/env node

/**
 * Convex DuckDB mirror client. Syncs a local DuckDB copy from a configured
 * mirror proxy. The client intentionally reads only `.convex-duckdb/config.json`
 * and never reads environment variables or `.env` files.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { Config } from "./http.js";
import { HttpError, mirrorGet } from "./http.js";
import {
  DUCKDB_PATH,
  formatDuration,
  getLocalStatus,
  LOCAL_DIR,
  performSync,
  printRowCounts,
  REPO_ROOT,
} from "./sync.js";

const CONFIG_PATH = join(LOCAL_DIR, "config.json");
const DEFAULT_PROXY_URL = "http://127.0.0.1:3002";
const COMMANDS = ["install", "status", "sync"] as const;
type Command = (typeof COMMANDS)[number];

interface ConfigFile {
  CONVEX_DUCKDB_PROXY_URL: string;
  CONVEX_DUCKDB_ACCESS_TOKEN: string;
}

interface ProxyStatus {
  ok: boolean;
  url: string | null;
  status?: unknown;
  authOk?: boolean;
  error?: string;
  statusCode?: number;
}

function printUsage(): void {
  console.log(`Usage: convex-duckdb <command> [options]

Commands:
  install           Write .convex-duckdb/config.json
  status            Check local snapshot, duckdb CLI, and proxy health
  sync              Sync the local DuckDB mirror

Options:
  --json            Print machine-readable output where supported
  --full            Force a full sync (sync only)
  --force           Override an active sync lock (sync only)
  --help            Show this help
`);
}

function parseCli(argv: string[]): {
  command: Command | null;
  json: boolean;
  full: boolean;
  force: boolean;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    return { command: null, json: Boolean(values.json), full: false, force: false };
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument(s): ${positionals.slice(1).join(", ")}`);
  }
  const [command] = positionals;
  if (!isCommand(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  return {
    command,
    json: Boolean(values.json),
    full: Boolean(values.full),
    force: Boolean(values.force),
  };
}

function isCommand(value: string): value is Command {
  return COMMANDS.includes(value as Command);
}

function readConfigFile(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing config file at ${relativePath(CONFIG_PATH)}. Run: npx convex-duckdb install`,
    );
  }

  let parsed: Partial<ConfigFile>;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ConfigFile>;
  } catch (error) {
    throw new Error(
      `Could not read ${relativePath(CONFIG_PATH)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const proxyUrl = parsed.CONVEX_DUCKDB_PROXY_URL?.trim().replace(/\/$/, "");
  const accessToken = parsed.CONVEX_DUCKDB_ACCESS_TOKEN?.trim();
  const missing = [
    !proxyUrl ? "CONVEX_DUCKDB_PROXY_URL" : null,
    !accessToken ? "CONVEX_DUCKDB_ACCESS_TOKEN" : null,
  ].filter((value): value is string => value !== null);

  if (missing.length > 0) {
    throw new Error(`${relativePath(CONFIG_PATH)} is missing: ${missing.join(", ")}`);
  }
  if (!proxyUrl || !accessToken) {
    throw new Error(`${relativePath(CONFIG_PATH)} is missing required config.`);
  }

  try {
    new URL(proxyUrl);
  } catch {
    throw new Error(`CONVEX_DUCKDB_PROXY_URL is not a valid URL in ${relativePath(CONFIG_PATH)}.`);
  }

  return { proxyUrl, accessToken };
}

async function installCommand(json: boolean): Promise<number> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("install requires an interactive terminal.");
  }

  const existing = readExistingConfigForInstall();
  const rl = createInterface({ input, output });
  try {
    const proxyUrl =
      (
        await rl.question(`CONVEX_DUCKDB_PROXY_URL (${existing?.proxyUrl ?? DEFAULT_PROXY_URL}): `)
      ).trim() ||
      existing?.proxyUrl ||
      DEFAULT_PROXY_URL;
    const accessToken = (
      await rl.question(
        `CONVEX_DUCKDB_ACCESS_TOKEN${existing?.accessToken ? " (leave blank to keep current)" : ""}: `,
      )
    ).trim();

    const finalAccessToken = accessToken || existing?.accessToken;
    if (!finalAccessToken) {
      throw new Error("CONVEX_DUCKDB_ACCESS_TOKEN is required.");
    }

    writeConfigFile({
      CONVEX_DUCKDB_PROXY_URL: proxyUrl.replace(/\/$/, ""),
      CONVEX_DUCKDB_ACCESS_TOKEN: finalAccessToken,
    });

    const result = {
      ok: true,
      configPath: relativePath(CONFIG_PATH),
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Wrote ${result.configPath}`);
    }
    return 0;
  } finally {
    rl.close();
  }
}

function writeConfigFile(config: ConfigFile): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

function readExistingConfigForInstall(): Config | null {
  try {
    return existsSync(CONFIG_PATH) ? readConfigFile() : null;
  } catch {
    return null;
  }
}

async function statusCommand(json: boolean): Promise<number> {
  const local = getLocalStatus();
  const duckdbCli = checkDuckdbCli();
  const config = readOptionalConfig();
  const proxy = config.ok ? await checkProxy(config.config) : null;
  const configStatus = config.ok
    ? {
        exists: true,
        path: relativePath(CONFIG_PATH),
        proxyUrl: config.config.proxyUrl,
      }
    : {
        exists: existsSync(CONFIG_PATH),
        path: relativePath(CONFIG_PATH),
        error: config.error,
      };

  const ok =
    config.ok &&
    local.status === "ready" &&
    duckdbCli.available &&
    proxy !== null &&
    proxy.ok &&
    proxy.authOk === true;

  const result = {
    ok,
    config: configStatus,
    local,
    duckdbCli,
    proxy,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(config.ok ? `Config: ${relativePath(CONFIG_PATH)}` : `Config: ${configStatus.error}`);
    console.log(`Local: ${local.message}`);
    console.log(
      duckdbCli.available
        ? `DuckDB CLI: ${duckdbCli.version ?? "available"}`
        : "DuckDB CLI: not found on PATH",
    );
    if (proxy) {
      console.log(proxy.ok ? `Proxy: ready (${proxy.url})` : `Proxy: ${proxy.error}`);
    } else {
      console.log("Proxy: skipped until config is valid");
    }
  }

  return 0;
}

async function syncCommand(options: {
  full: boolean;
  force: boolean;
  json: boolean;
}): Promise<number> {
  const config = readConfigFile();
  const run = () =>
    performSync(config, {
      full: options.full,
      force: options.force,
    });

  const result = options.json ? await withConsoleLogSilenced(run) : await run();
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          duckdbPath: relativePath(DUCKDB_PATH),
          proxyUrl: config.proxyUrl,
          mode: result.mode,
          durationMs: Math.round(result.durationMs),
        },
        null,
        2,
      ),
    );
  } else {
    await printRowCounts();
    console.log(`\n==> Done! DuckDB database: ${DUCKDB_PATH}`);
    console.log(`    Proxy: ${config.proxyUrl}`);
    console.log(`    Mode: ${result.mode}, duration: ${formatDuration(result.durationMs)}`);
    console.log(`    Open with: duckdb ${DUCKDB_PATH}`);
  }
  return 0;
}

function readOptionalConfig(): { ok: true; config: Config } | { ok: false; error: string } {
  try {
    return { ok: true, config: readConfigFile() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkProxy(config: Config): Promise<ProxyStatus> {
  try {
    const status = await mirrorGet<unknown>(config, "/status", {});
    await mirrorGet<unknown>(config, "/api/json_schemas", { format: "json" });
    return {
      ok: true,
      url: config.proxyUrl,
      status,
      authOk: true,
    };
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.status : undefined;
    return {
      ok: false,
      url: config.proxyUrl,
      authOk: statusCode === undefined ? undefined : ![401, 403].includes(statusCode),
      statusCode,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkDuckdbCli(): { available: boolean; version: string | null } {
  const result = spawnSync("duckdb", ["--version"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return { available: false, version: null };
  }
  return {
    available: true,
    version: (result.stdout || result.stderr).trim() || null,
  };
}

async function withConsoleLogSilenced<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

function relativePath(path: string): string {
  return relative(REPO_ROOT, path) || ".";
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.command) {
    printUsage();
    return 0;
  }

  if (parsed.command !== "sync" && (parsed.full || parsed.force)) {
    throw new Error("--full and --force are only valid for sync.");
  }

  if (parsed.command === "install") return installCommand(parsed.json);
  if (parsed.command === "status") return statusCommand(parsed.json);
  return syncCommand(parsed);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    const json = process.argv.includes("--json");
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.error(JSON.stringify({ error: { message } }, null, 2));
    } else {
      console.error("Fatal:", message);
    }
    process.exit(1);
  },
);
