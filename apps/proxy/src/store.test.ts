import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databasePath, openDeltasStore } from "./store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convex-duckdb-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openDeltasStore", () => {
  it("creates the SQLite database when the data directory is empty", async () => {
    const root = await makeTempDir();
    const dataDir = join(root, "nested", "data");

    const store = openDeltasStore(dataDir);
    try {
      expect(existsSync(databasePath(dataDir))).toBe(true);
      expect(store.readState()).toEqual({
        latestCursor: null,
        oldestCursor: null,
        lastPollAt: null,
        lastEventAt: null,
        lastError: null,
      });
    } finally {
      store.close();
    }
  });
});
