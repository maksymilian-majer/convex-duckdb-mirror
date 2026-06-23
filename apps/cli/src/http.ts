const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

export interface Config {
  proxyUrl: string;
  accessToken: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

function parseConvexJson<T>(raw: string): T {
  const safeRaw = raw.replace(
    /"(cursor|snapshot|_ts|latestCursor|oldestCursor)"\s*:\s*(\d{16,})/g,
    '"$1":"$2"',
  );
  return JSON.parse(safeRaw) as T;
}

async function fetchJson<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
): Promise<T> {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const maxDelay = RETRY_BASE_MS * 2 ** (attempt - 1);
      const delay = Math.round(Math.random() * maxDelay);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }

    try {
      const response = await fetch(url.toString(), { headers });
      const raw = await response.text();
      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} from ${path}: ${raw}`, response.status, raw);
      }
      return parseConvexJson<T>(raw);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isInvalidWindowError(lastError)) {
        throw lastError;
      }
      if (attempt < MAX_RETRIES - 1) {
        console.error(`Retry ${attempt + 1}/${MAX_RETRIES - 1} for ${path}: ${lastError.message}`);
      }
    }
  }

  throw lastError;
}

export async function mirrorGet<T>(
  config: Config,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  return fetchJson<T>(config.proxyUrl, path, params, {
    "Accept-Encoding": "zstd, gzip, deflate",
    Authorization: `Bearer ${config.accessToken}`,
    "Convex-Client": "convex-duckdb-0.1",
  });
}

export function isInvalidWindowError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status !== 400) return false;
  return error.body.includes("InvalidWindowToReadDocuments");
}

/** @deprecated Use mirrorGet */
export const proxyGet = mirrorGet;
