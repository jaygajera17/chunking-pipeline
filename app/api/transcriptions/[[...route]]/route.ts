import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";

import {
  getTranscriptionResultForSession,
  getTranscriptionStatusForSession,
} from "@/lib/recording/recording-service";

export const runtime = "nodejs";

// Bootstrap endpoints for transcription status and stitched result.
const app = new Hono().basePath("/api/transcriptions");

const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});

app.get(
  "/:sessionId/status",
  zValidator("param", sessionIdParamSchema),
  async (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      return c.json(await getTranscriptionStatusForSession(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

app.get(
  "/:sessionId/result",
  zValidator("param", sessionIdParamSchema),
  async (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      return c.json(await getTranscriptionResultForSession(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

export const GET = handle(app);
