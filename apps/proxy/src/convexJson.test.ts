import { describe, expect, it } from "vitest";
import { parseConvexJson, stringifyConvexJson } from "./convexJson.js";

describe("convexJson", () => {
  it("parses Convex timestamp fields as BigInt without precision loss", () => {
    const parsed = parseConvexJson<{ cursor: bigint; values: Array<{ _ts: bigint }> }>(
      '{"cursor":1234567890123456789,"values":[{"_ts":9876543210987654321}]}',
    );

    expect(parsed.cursor).toBe(1234567890123456789n);
    expect(parsed.values[0]._ts).toBe(9876543210987654321n);
  });

  it("serializes BigInt fields as raw JSON numbers", () => {
    const serialized = stringifyConvexJson({
      cursor: 1234567890123456789n,
      values: [{ _ts: 9876543210987654321n }],
    });

    expect(serialized).toBe(
      '{"cursor":1234567890123456789,"values":[{"_ts":9876543210987654321}]}',
    );
  });
});
