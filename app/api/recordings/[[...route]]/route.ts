import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";

import {
  createSessionRecord,
  finalizeSessionRecord,
  heartbeatSessionRecord,
  reconcileSessionRange,
  repairChunkFromPayload,
  uploadChunkWithDurability,
} from "@/lib/recording/recording-service";

export const runtime = "nodejs";

// Bootstrap API mounted under /api/recordings.
const app = new Hono().basePath("/api/recordings");

const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});

const chunkIdParamSchema = z.object({
  chunkId: z.string().min(1),
});

const finalizeBodySchema = z.object({
  expectedLastSequenceNo: z.number().int().nonnegative(),
});

const reconcileBodySchema = z.union([
  z.object({
    sessionId: z.string().uuid(),
    expectedLastSequenceNo: z.number().int().nonnegative(),
  }),
  z.object({
    sessionId: z.string().uuid(),
    sequenceNoStart: z.number().int().nonnegative(),
    sequenceNoEnd: z.number().int().nonnegative(),
  }),
]);

app.post("/sessions", async (c) => {
  try {
    const session = await createSessionRecord();
    return c.json(
      {
        sessionId: session.id,
        status: session.status,
        startedAt: session.startedAt,
      },
      201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

app.patch(
  "/sessions/:sessionId/heartbeat",
  zValidator("param", sessionIdParamSchema),
  async (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      return c.json(await heartbeatSessionRecord(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

app.put(
  "/chunks/:chunkId",
  zValidator("param", chunkIdParamSchema),
  async (c) => {
    const { chunkId } = c.req.valid("param");
    const sessionId = c.req.header("x-session-id");
    const sequenceNoHeader = c.req.header("x-sequence-no");
    const sha256 = c.req.header("x-sha256");
    const sizeBytesHeader = c.req.header("x-size-bytes");
    const mimeType =
      c.req.header("content-type")?.trim() || "audio/webm;codecs=opus";

    const sequenceNo = Number(sequenceNoHeader);
    const sizeBytes = Number(sizeBytesHeader);

    if (!sessionId || !sha256 || Number.isNaN(sequenceNo) || sequenceNo < 0) {
      return c.json(
        {
          error:
            "Missing required upload headers (x-session-id, x-sequence-no, x-sha256)",
        },
        400,
      );
    }

    const payloadBuffer = Buffer.from(await c.req.arrayBuffer());

    if (!Number.isNaN(sizeBytes) && sizeBytes !== payloadBuffer.byteLength) {
      return c.json({ error: "x-size-bytes does not match payload size" }, 400);
    }

    try {
      // Idempotent upsert behavior is handled inside the store function.
      const result = await uploadChunkWithDurability({
        chunkId,
        sessionId,
        sequenceNo,
        sha256,
        sizeBytes: payloadBuffer.byteLength,
        mimeType,
        payloadBuffer,
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
  async (c) => {
    const { sessionId } = c.req.valid("param");
    const { expectedLastSequenceNo } = c.req.valid("json");

    try {
      // Finalize enforces contiguous chunk coverage before transcription queueing.
      const result = await finalizeSessionRecord(
        sessionId,
        expectedLastSequenceNo,
      );
      return c.json(result, result.finalized ? 200 : 409);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

app.post("/reconcile", zValidator("json", reconcileBodySchema), async (c) => {
  const body = c.req.valid("json");
  const sessionId = body.sessionId;

  try {
    const rangeStart =
      "expectedLastSequenceNo" in body ? 0 : body.sequenceNoStart;
    const rangeEnd =
      "expectedLastSequenceNo" in body
        ? body.expectedLastSequenceNo
        : body.sequenceNoEnd;

    const result = await reconcileSessionRange(sessionId, rangeStart, rangeEnd);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 404);
  }
});

app.post(
  "/repair/:chunkId",
  zValidator("param", chunkIdParamSchema),
  async (c) => {
    const { chunkId } = c.req.valid("param");

    try {
      const payloadBuffer = Buffer.from(await c.req.arrayBuffer());
      const repaired = await repairChunkFromPayload(chunkId, payloadBuffer);

      return c.json({
        chunkId,
        ackState: repaired.ackState,
        ackedAt: repaired.ackedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
