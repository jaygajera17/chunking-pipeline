import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";

import {
  createSession,
  finalizeSession,
  heartbeatSession,
  reconcileSession,
  repairChunk,
  upsertChunk,
} from "@/lib/recording/bootstrap-store";

export const runtime = "nodejs";

const app = new Hono().basePath("/api/recordings");

const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});

const chunkIdParamSchema = z.object({
  chunkId: z.string().min(1),
});

const putChunkBodySchema = z.object({
  sessionId: z.string().uuid(),
  sequenceNo: z.number().int().nonnegative(),
  sha256: z.string().min(32),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().default("audio/webm;codecs=opus"),
});

const finalizeBodySchema = z.object({
  expectedLastSequenceNo: z.number().int().nonnegative(),
});

const reconcileBodySchema = z.object({
  sessionId: z.string().uuid(),
  sequenceNoStart: z.number().int().nonnegative(),
  sequenceNoEnd: z.number().int().nonnegative(),
});

app.post("/sessions", (c) => {
  const session = createSession();
  return c.json(
    {
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt,
    },
    201,
  );
});

app.patch(
  "/sessions/:sessionId/heartbeat",
  zValidator("param", sessionIdParamSchema),
  (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      return c.json(heartbeatSession(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

app.put(
  "/chunks/:chunkId",
  zValidator("param", chunkIdParamSchema),
  zValidator("json", putChunkBodySchema),
  (c) => {
    const { chunkId } = c.req.valid("param");
    const body = c.req.valid("json");

    try {
      const result = upsertChunk({
        chunkId,
        sessionId: body.sessionId,
        sequenceNo: body.sequenceNo,
        sha256: body.sha256,
        sizeBytes: body.sizeBytes,
        mimeType: body.mimeType,
      });

      return c.json(
        {
          chunkId,
          duplicate: result.duplicate,
          ackState: result.chunk.ackState,
          ackedAt: result.chunk.ackedAt,
          bucketKey: result.chunk.bucketKey,
          bucketEtag: result.chunk.bucketEtag,
        },
        200,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 400);
    }
  },
);

app.post(
  "/sessions/:sessionId/finalize",
  zValidator("param", sessionIdParamSchema),
  zValidator("json", finalizeBodySchema),
  (c) => {
    const { sessionId } = c.req.valid("param");
    const { expectedLastSequenceNo } = c.req.valid("json");

    try {
      const result = finalizeSession(sessionId, expectedLastSequenceNo);
      return c.json(result, result.finalized ? 200 : 409);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

app.post("/reconcile", zValidator("json", reconcileBodySchema), (c) => {
  const { sessionId, sequenceNoStart, sequenceNoEnd } = c.req.valid("json");

  try {
    const result = reconcileSession(sessionId, sequenceNoStart, sequenceNoEnd);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 404);
  }
});

app.post("/repair/:chunkId", zValidator("param", chunkIdParamSchema), (c) => {
  const { chunkId } = c.req.valid("param");

  try {
    const repaired = repairChunk(chunkId);
    return c.json({
      chunkId: repaired.chunkId,
      ackState: repaired.ackState,
      ackedAt: repaired.ackedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 404);
  }
});

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
