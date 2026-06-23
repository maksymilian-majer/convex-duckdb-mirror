import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProxyServer } from "./app.js";
import { openDeltasStore } from "./store.js";

const TOKEN = "test-token";
const CONVEX = {
  baseUrl: "https://example.convex.cloud",
  deployKey: "deploy-key",
};
const tempDirs: string[] = [];

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convex-duckdb-proxy-test-"));
  tempDirs.push(dir);
  return dir;
}

function openTestStore(dataDir: string) {
  return openDeltasStore(dataDir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("document_deltas route", () => {
  it("serves global deltas with raw BigInt cursor tokens", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    store.writeState({
      latestCursor: 1781775399992483617n,
      oldestCursor: 100n,
      lastPollAt: null,
      lastEventAt: null,
      lastError: null,
    });
    store.appendDeltas(
      [
        { _table: "tweets", _id: "a", _ts: 1781775395123456789n, _deleted: false, value: 1 },
        { _table: "users", _id: "b", _ts: 1781775399123456789n, _deleted: true },
      ],
      new Date().toISOString(),
    );

    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN });
    const response = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"cursor":1781775399992483617');
    expect(response.body).toContain('"_ts":1781775395123456789');
    expect(response.json()).toMatchObject({
      hasMore: false,
      values: [
        { _table: "tweets", _id: "a", _deleted: false, value: 1 },
        { _table: "users", _id: "b", _deleted: true },
      ],
    });
    await app.close();
  });

  it("filters local deltas by tableName when provided", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    store.writeState({
      latestCursor: 300n,
      oldestCursor: 100n,
      lastPollAt: null,
      lastEventAt: null,
      lastError: null,
    });
    store.appendDeltas(
      [
        { _table: "tweets", _id: "a", _ts: 150n, _deleted: false, value: 1 },
        { _table: "users", _id: "b", _ts: 250n, _deleted: false, value: 2 },
      ],
      new Date().toISOString(),
    );

    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN });
    const response = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100&tableName=tweets",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursor: 300,
      hasMore: false,
      values: [{ _table: "tweets", _id: "a", _deleted: false, value: 1 }],
    });
    await app.close();
  });

  it("does not return deltas beyond the current proxy cursor", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    store.writeState({
      latestCursor: 200n,
      oldestCursor: 100n,
      lastPollAt: null,
      lastEventAt: null,
      lastError: null,
    });
    store.appendDeltas(
      [
        { _table: "tweets", _id: "a", _ts: 150n, _deleted: false },
        { _table: "tweets", _id: "future", _ts: 250n, _deleted: false },
      ],
      new Date().toISOString(),
    );

    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN });
    const response = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursor: 200,
      hasMore: false,
      values: [{ _table: "tweets", _id: "a" }],
    });
    await app.close();
  });

  it("requires bearer auth for mirror data routes", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN, convex: CONVEX });

    const health = await app.inject({ method: "GET", url: "/health" });
    const missing = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100",
      headers: { authorization: "Bearer wrong" },
    });
    const missingSnapshot = await app.inject({
      method: "GET",
      url: "/api/json_schemas?format=json",
    });

    expect(health.statusCode).toBe(200);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: "missing_bearer_token" });
    expect(invalid.statusCode).toBe(403);
    expect(invalid.json()).toEqual({ error: "invalid_bearer_token" });
    expect(missingSnapshot.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 when document delta auth is not configured", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    store.writeState({
      latestCursor: 300n,
      oldestCursor: 100n,
      lastPollAt: null,
      lastEventAt: null,
      lastError: null,
    });
    const app = buildProxyServer({ store, pageSize: 128, convex: CONVEX });

    const status = await app.inject({ method: "GET", url: "/status" });
    const response = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100",
      headers: authHeaders(),
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      ready: false,
      deltasReady: true,
      dataRoutesConfigured: false,
      configurationError: "CONVEX_DUCKDB_ACCESS_TOKEN is not configured",
      snapshotPassthrough: true,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "data_routes_not_configured" });
    await app.close();
  });

  it("does not split rows that share the same timestamp across pages", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    store.writeState({
      latestCursor: 300n,
      oldestCursor: 100n,
      lastPollAt: null,
      lastEventAt: null,
      lastError: null,
    });
    store.appendDeltas(
      [
        { _table: "tweets", _id: "a", _ts: 150n, _deleted: false },
        { _table: "tweets", _id: "b", _ts: 150n, _deleted: false },
        { _table: "tweets", _id: "c", _ts: 250n, _deleted: false },
      ],
      new Date().toISOString(),
    );

    const app = buildProxyServer({ store, pageSize: 1, bearerToken: TOKEN });
    const response = await app.inject({
      method: "GET",
      url: "/api/document_deltas?format=json&cursor=100",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursor: 150,
      hasMore: true,
      values: [
        { _table: "tweets", _id: "a" },
        { _table: "tweets", _id: "b" },
      ],
    });
    await app.close();
  });
});

describe("snapshot passthrough routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes through json_schemas without parsing the upstream body", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://example.convex.cloud/api/json_schemas?format=json");
      return new Response('{"tweets":{"type":"object"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN, convex: CONVEX });
    const response = await app.inject({
      method: "GET",
      url: "/api/json_schemas?format=json",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"tweets":{"type":"object"}}');
    await app.close();
  });

  it("passes through list_snapshot query params verbatim", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://example.convex.cloud/api/list_snapshot?format=json&tableName=tweets&snapshot=100",
      );
      return new Response(
        '{"snapshot":100,"cursor":"{\\"tablet\\":\\"1\\",\\"id\\":\\"abc\\"}","hasMore":false,"values":[]}',
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN, convex: CONVEX });
    const response = await app.inject({
      method: "GET",
      url: "/api/list_snapshot?format=json&tableName=tweets&snapshot=100",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"snapshot":100');
    expect(response.body).toContain("tablet");
    await app.close();
  });

  it("returns 503 when convex upstream is not configured", async () => {
    const dataDir = await makeDataDir();
    const store = openTestStore(dataDir);
    const app = buildProxyServer({ store, pageSize: 128, bearerToken: TOKEN });
    const response = await app.inject({
      method: "GET",
      url: "/api/json_schemas?format=json",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "ProxyNotReady" });
    await app.close();
  });
});
