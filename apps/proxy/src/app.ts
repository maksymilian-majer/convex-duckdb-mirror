import type { FastifyReply, FastifyRequest } from "fastify";
import fastify from "fastify";
import { parseCursor, stringifyConvexJson } from "./convexJson.js";
import {
  type ConvexUpstreamConfig,
  forwardConvexGet,
  normalizeQuery,
} from "./convexPassthrough.js";
import {
  markRequestStart,
  queueMsSinceRequestStart,
  roundMs,
  scheduleDocumentDeltaPageLog,
} from "./requestTiming.js";
import type { DeltasStore } from "./store.js";

export interface BuildProxyServerOptions {
  store: DeltasStore;
  pageSize: number;
  bearerToken?: string;
  convex?: ConvexUpstreamConfig;
}

interface DocumentDeltasQuery {
  cursor?: string;
  format?: string;
  tableName?: string;
}

interface DocumentDeltasPage {
  body: string;
  cursor: bigint;
  hasMore: boolean;
  timings: {
    sqlMs: number;
    jsonMs: number;
    rowCount: number;
  };
}

function invalidWindowResponse(cursor: bigint, oldestCursor: bigint): string {
  return stringifyConvexJson({
    code: "InvalidWindowToReadDocuments",
    message: `Trying to synchronize from timestamp ${cursor.toString()}, which is older than the proxy retention window. Oldest retained cursor is ${oldestCursor.toString()}. Please perform a full sync.`,
  });
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

async function requireBearerAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  bearerToken?: string,
): Promise<void> {
  if (!bearerToken) {
    await reply.code(503).send({ error: "data_routes_not_configured" });
    return;
  }

  const token = getBearerToken(request);
  if (token === null) {
    await reply.code(401).send({ error: "missing_bearer_token" });
    return;
  }

  if (token !== bearerToken) {
    await reply.code(403).send({ error: "invalid_bearer_token" });
  }
}

async function sendConvexPassthrough(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  convex?: ConvexUpstreamConfig,
): Promise<void> {
  if (!convex) {
    await reply.code(503).send({
      code: "ProxyNotReady",
      message: "Convex upstream is not configured on this mirror.",
    });
    return;
  }

  const query =
    typeof request.query === "object" && request.query !== null
      ? normalizeQuery(request.query as Record<string, unknown>)
      : {};
  const upstream = await forwardConvexGet(convex, path, query);
  if (upstream.contentType) {
    reply.type(upstream.contentType);
  }
  await reply.code(upstream.status).send(upstream.body);
}

export function buildProxyServer(options: BuildProxyServerOptions) {
  const app = fastify({ logger: true });
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> =>
    requireBearerAuth(request, reply, options.bearerToken);

  app.addHook("onRequest", async (request) => {
    markRequestStart(request);
  });

  app.addHook("onClose", async () => {
    options.store.close();
  });

  app.get("/", async () => ({
    service: "convex-duckdb-proxy",
  }));

  app.get("/health", async () => ({ ok: true }));

  app.get("/status", async () => {
    const state = options.store.readState();
    const deltasReady = state.latestCursor !== null;
    const dataRoutesConfigured =
      options.bearerToken !== undefined && options.bearerToken.length > 0;
    const snapshotPassthrough = options.convex !== undefined;
    return {
      ready: deltasReady && dataRoutesConfigured && snapshotPassthrough,
      deltasReady,
      dataRoutesConfigured,
      latestCursor: state.latestCursor?.toString() ?? null,
      oldestCursor: state.oldestCursor?.toString() ?? null,
      lastPollAt: state.lastPollAt,
      lastEventAt: state.lastEventAt,
      lastError: state.lastError,
      configurationError: dataRoutesConfigured
        ? null
        : "CONVEX_DUCKDB_ACCESS_TOKEN is not configured",
      snapshotPassthrough,
    };
  });

  app.get("/api/json_schemas", { preHandler: authenticate }, async (request, reply) =>
    sendConvexPassthrough(request, reply, "/api/json_schemas", options.convex),
  );

  app.get("/api/list_snapshot", { preHandler: authenticate }, async (request, reply) =>
    sendConvexPassthrough(request, reply, "/api/list_snapshot", options.convex),
  );

  app.get<{ Querystring: DocumentDeltasQuery }>(
    "/api/document_deltas",
    { preHandler: authenticate },
    async (request, reply) => {
      const queueMs = queueMsSinceRequestStart(request);

      if (request.query.format !== undefined && request.query.format !== "json") {
        return reply
          .code(400)
          .send({ code: "InvalidFormat", message: "Only format=json is supported." });
      }
      let cursor: bigint;
      try {
        cursor = parseCursor(request.query.cursor);
      } catch (error) {
        return reply.code(400).send({
          code: "DocumentDeltasCursorRequired",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const readStateStartedAt = performance.now();
      const state = options.store.readState();
      const readStateMs = performance.now() - readStateStartedAt;
      if (state.latestCursor === null || state.oldestCursor === null) {
        return reply.code(503).send({
          code: "ProxyNotReady",
          message: "The proxy has not seeded a Convex cursor yet.",
        });
      }

      if (cursor < state.oldestCursor) {
        return reply
          .code(400)
          .type("application/json")
          .send(invalidWindowResponse(cursor, state.oldestCursor));
      }

      const page: DocumentDeltasPage = options.store.pageDeltas(
        cursor,
        state.latestCursor,
        options.pageSize,
        request.query.tableName,
      );
      const { timings } = page;
      const bodyBytes = Buffer.byteLength(page.body, "utf8");
      const logFields = {
        cursor: cursor.toString(),
        returnedCursor: page.cursor.toString(),
        latestCursor: state.latestCursor.toString(),
        tableName: request.query.tableName ?? null,
        rowCount: timings.rowCount,
        hasMore: page.hasMore,
        bodyBytes,
        queueMs: queueMs === null ? null : roundMs(queueMs),
        readStateMs: roundMs(readStateMs),
        sqlMs: roundMs(timings.sqlMs),
        jsonMs: roundMs(timings.jsonMs),
        sendMs: 0,
      };
      const sendStartedAt = performance.now();
      const markSendComplete = scheduleDocumentDeltaPageLog(request, reply, (sendCompletedAt) => ({
        ...logFields,
        sendMs: roundMs(sendCompletedAt - sendStartedAt),
      }));
      await reply.type("application/json").send(page.body);
      markSendComplete(performance.now());
    },
  );

  return app;
}
