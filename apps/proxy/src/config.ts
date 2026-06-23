import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const ENV_FILE = join(REPO_ROOT, "apps/proxy/.env.local");
const DEFAULT_DATA_DIR = join(REPO_ROOT, "apps/proxy/data");

export interface ProxyConfig {
  port: number;
  host: string;
  dataDir: string;
  convexBaseUrl: string;
  convexDeployKey: string;
  dataBearerToken: string;
  pollIntervalSeconds: number;
  retentionHours: number;
  pageSize: number;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function resolveDataDir(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export function loadProxyConfig(): ProxyConfig {
  if (existsSync(ENV_FILE)) {
    loadDotenv({ path: ENV_FILE });
  }

  const convexDeployKey = process.env.SYNC_CONVEX_DEPLOY_KEY;
  if (!convexDeployKey) {
    throw new Error("SYNC_CONVEX_DEPLOY_KEY is required.");
  }

  const convexBaseUrl = (
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL ??
    ""
  ).replace(/\/$/, "");
  if (!convexBaseUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL or CONVEX_URL is required.");
  }

  const dataBearerToken = process.env.CONVEX_DUCKDB_ACCESS_TOKEN;
  if (!dataBearerToken) {
    throw new Error("CONVEX_DUCKDB_ACCESS_TOKEN is required.");
  }

  return {
    port: Math.trunc(readNumberEnv("PORT", 3002)),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir: resolveDataDir(
      process.env.CONVEX_DUCKDB_PROXY_DATA_DIR ??
        process.env.DELTAS_PROXY_DATA_DIR ??
        DEFAULT_DATA_DIR,
    ),
    convexBaseUrl,
    convexDeployKey,
    dataBearerToken,
    pollIntervalSeconds: Math.trunc(readNumberEnv("DELTA_POLL_INTERVAL_SECONDS", 30)),
    retentionHours: readNumberEnv("DELTA_RETENTION_HOURS", 24 * 7),
    pageSize: Math.trunc(readNumberEnv("DOCUMENT_DELTAS_PAGE_SIZE", 128)),
  };
}
