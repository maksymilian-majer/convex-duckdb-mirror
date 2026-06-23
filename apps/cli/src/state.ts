import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { writeAtomicJsonFile } from "./atomicJsonFile.js";

const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export interface Metadata {
  status: "syncing" | "ready";
  startedAt?: string;
  exportedAt?: string;
  pid?: number;
}

export interface SyncState {
  lastAppliedCursor: string;
  updatedAt: string;
}

export interface StatePaths {
  metadataFile: string;
  syncStateFile: string;
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeAtomicJsonFile(dirname(path), basename(path), value);
}

export function readMetadata(paths: StatePaths): Metadata | null {
  return readJsonFile<Metadata>(paths.metadataFile);
}

export async function writeMetadata(paths: StatePaths, meta: Metadata): Promise<void> {
  await writeJsonFile(paths.metadataFile, meta);
}

export function readSyncState(paths: StatePaths): SyncState | null {
  const state = readJsonFile<Partial<SyncState>>(paths.syncStateFile);
  if (typeof state?.lastAppliedCursor !== "string" || typeof state.updatedAt !== "string") {
    return null;
  }
  return {
    lastAppliedCursor: state.lastAppliedCursor,
    updatedAt: state.updatedAt,
  };
}

export async function writeSyncState(paths: StatePaths, state: SyncState): Promise<void> {
  await writeJsonFile(paths.syncStateFile, state);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export function isOrphanedLock(meta: Metadata): boolean {
  return meta.pid != null && !isProcessAlive(meta.pid);
}

export function checkLock(paths: StatePaths, force: boolean): void {
  const meta = readMetadata(paths);
  if (!meta || meta.status !== "syncing") return;

  const startedAt = meta.startedAt ? new Date(meta.startedAt).getTime() : 0;
  const elapsed = Date.now() - startedAt;
  if (isOrphanedLock(meta)) {
    console.log(`==> Stale lock detected (pid ${meta.pid} is not running). Overriding.`);
    return;
  }
  if (elapsed > LOCK_TIMEOUT_MS) {
    console.log(
      `==> Stale lock detected (started ${Math.round(elapsed / 60_000)} min ago). Overriding.`,
    );
    return;
  }
  if (force) {
    console.log("==> Lock active; overriding due to --force.");
    return;
  }

  throw new Error(
    `A sync is already in progress (pid ${meta.pid ?? "unknown"}, started ${Math.round(
      elapsed / 1000,
    )}s ago). Re-run with --force only if it is orphaned.`,
  );
}

export async function acquireLock(paths: StatePaths): Promise<void> {
  await writeMetadata(paths, {
    status: "syncing",
    startedAt: new Date().toISOString(),
    pid: process.pid,
  });
}

export async function releaseLock(paths: StatePaths, state: SyncState): Promise<void> {
  await writeMetadata(paths, {
    status: "ready",
    exportedAt: state.updatedAt,
  });
}
