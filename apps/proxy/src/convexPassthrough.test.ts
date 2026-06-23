import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardConvexGet, normalizeQuery } from "./convexPassthrough.js";

describe("normalizeQuery", () => {
  it("drops undefined values and keeps the last array entry", () => {
    expect(
      normalizeQuery({
        format: "json",
        tableName: ["tweets", "users"],
        unused: undefined,
      }),
    ).toEqual({
      format: "json",
      tableName: "users",
    });
  });
});

describe("forwardConvexGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards query params and returns the upstream body unchanged", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://example.convex.cloud/api/list_snapshot?format=json&tableName=tweets&snapshot=100",
      );
      return new Response('{"snapshot":100,"hasMore":false,"values":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await forwardConvexGet(
      { baseUrl: "https://example.convex.cloud", deployKey: "deploy-key" },
      "/api/list_snapshot",
      { format: "json", tableName: "tweets", snapshot: "100" },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(response.body).toBe('{"snapshot":100,"hasMore":false,"values":[]}');
  });

  it("passes through upstream error responses", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { code: "InvalidFormat", message: "Only format=json is supported." },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await forwardConvexGet(
      { baseUrl: "https://example.convex.cloud", deployKey: "deploy-key" },
      "/api/json_schemas",
      { format: "xml" },
      fetchMock,
    );

    expect(response.status).toBe(400);
    expect(response.body).toContain("InvalidFormat");
  });
});
