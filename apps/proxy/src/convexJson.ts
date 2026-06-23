export type JsonRecord = Record<string, unknown>;

const BIGINT_JSON_FIELDS = new Set(["cursor", "snapshot", "_ts", "latestCursor", "oldestCursor"]);
const UINT_RE = /^\d+$/;

interface JsonParseContext {
  source?: string;
}

interface JsonWithRaw {
  rawJSON: (text: string) => unknown;
}

export function assertBigIntJsonRuntime(): void {
  const json = JSON as JSON & Partial<JsonWithRaw>;
  if (typeof json.rawJSON !== "function") {
    throw new Error("Node 24+ is required because JSON.rawJSON is unavailable.");
  }

  let hasSourceContext = false;
  JSON.parse('{"cursor":1234567890123456789}', (key, _value, context?: JsonParseContext) => {
    if (key === "cursor" && context?.source === "1234567890123456789") {
      hasSourceContext = true;
    }
    return _value;
  });

  if (!hasSourceContext) {
    throw new Error("Node 24+ is required because JSON.parse source context is unavailable.");
  }
}

export function parseConvexJson<T>(raw: string): T {
  return JSON.parse(raw, (key, value, context?: JsonParseContext) => {
    if (BIGINT_JSON_FIELDS.has(key) && context?.source && UINT_RE.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  }) as T;
}

export function stringifyConvexJson(value: unknown): string {
  const json = JSON as JSON & JsonWithRaw;
  return JSON.stringify(value, (_key, fieldValue) => {
    if (typeof fieldValue === "bigint") {
      return json.rawJSON(fieldValue.toString());
    }
    return fieldValue;
  });
}

export function parseCursor(value: unknown, fieldName = "cursor"): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new Error(`${fieldName} must be an unsigned integer string.`);
  }
  return BigInt(value);
}
