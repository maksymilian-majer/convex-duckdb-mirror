import type { FastifyReply, FastifyRequest } from "fastify";

const requestStartMs = new WeakMap<FastifyRequest, number>();

export interface DocumentDeltaPageLogFields {
  cursor: string;
  returnedCursor: string;
  latestCursor: string;
  tableName: string | null;
  rowCount: number;
  hasMore: boolean;
  bodyBytes: number;
  queueMs: number | null;
  readStateMs: number;
  sqlMs: number;
  jsonMs: number;
  sendMs: number;
}

export function markRequestStart(request: FastifyRequest): void {
  requestStartMs.set(request, performance.now());
}

export function queueMsSinceRequestStart(request: FastifyRequest): number | null {
  const startedAt = requestStartMs.get(request);
  if (startedAt === undefined) return null;
  return performance.now() - startedAt;
}

export function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

export function scheduleDocumentDeltaPageLog(
  request: FastifyRequest,
  reply: FastifyReply,
  buildFields: (sendCompletedAt: number) => DocumentDeltaPageLogFields,
): (sendCompletedAt: number) => void {
  const sendState = { completedAt: null as number | null };

  reply.raw.once("finish", () => {
    const sendCompletedAt = sendState.completedAt ?? performance.now();
    const flushMs = performance.now() - sendCompletedAt;
    const requestStartedAt = requestStartMs.get(request);
    const totalMs =
      requestStartedAt === undefined ? null : roundMs(performance.now() - requestStartedAt);

    request.log.info(
      {
        ...buildFields(sendCompletedAt),
        flushMs: roundMs(flushMs),
        totalMs,
      },
      "Document delta page loaded",
    );
  });

  return (sendCompletedAt: number) => {
    sendState.completedAt = sendCompletedAt;
  };
}
