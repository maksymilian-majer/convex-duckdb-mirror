export interface ConvexUpstreamConfig {
  baseUrl: string;
  deployKey: string;
}

export interface ConvexPassthroughResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export type FetchFn = typeof fetch;

export function normalizeQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const last = value.at(-1);
      if (typeof last === "string") out[key] = last;
      continue;
    }
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export function buildConvexGetUrl(
  config: ConvexUpstreamConfig,
  path: string,
  query: Record<string, string>,
): URL {
  const url = new URL(path, config.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

export function convexAuthHeaders(config: ConvexUpstreamConfig): Record<string, string> {
  return {
    Authorization: `Convex ${config.deployKey}`,
    "Convex-Client": "convex-duckdb-proxy-0.1",
  };
}

export async function forwardConvexGet(
  config: ConvexUpstreamConfig,
  path: string,
  query: Record<string, string>,
  fetchFn: FetchFn = fetch,
): Promise<ConvexPassthroughResponse> {
  const url = buildConvexGetUrl(config, path, query);
  const response = await fetchFn(url.toString(), {
    headers: convexAuthHeaders(config),
  });

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}
