import { type JsonRecord, parseConvexJson } from "./convexJson.js";

export interface ConvexClientConfig {
  baseUrl: string;
  deployKey: string;
}

export interface DocumentDeltasPage {
  values: JsonRecord[];
  cursor: bigint;
  hasMore: boolean;
}

export interface ListSnapshotPage {
  values: JsonRecord[];
  snapshot: bigint;
  cursor?: string | null;
  hasMore: boolean;
}

async function convexGet<T>(
  config: ConvexClientConfig,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(path, config.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Convex ${config.deployKey}`,
      "Convex-Client": "convex-duckdb-proxy-0.1",
    },
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${raw}`);
  }
  return parseConvexJson<T>(raw);
}

export async function seedCursorFromSnapshot(config: ConvexClientConfig): Promise<bigint> {
  const page = await convexGet<ListSnapshotPage>(config, "/api/list_snapshot", {
    format: "json",
  });
  if (typeof page.snapshot !== "bigint") {
    throw new Error("Unexpected /api/list_snapshot response: missing snapshot.");
  }
  return page.snapshot;
}

export async function fetchGlobalDeltas(
  config: ConvexClientConfig,
  cursor: bigint,
): Promise<DocumentDeltasPage> {
  const page = await convexGet<Partial<DocumentDeltasPage>>(config, "/api/document_deltas", {
    format: "json",
    cursor: cursor.toString(),
  });

  if (!Array.isArray(page.values) || typeof page.cursor !== "bigint") {
    throw new Error("Unexpected /api/document_deltas response.");
  }

  return {
    values: page.values,
    cursor: page.cursor,
    hasMore: page.hasMore === true,
  };
}
