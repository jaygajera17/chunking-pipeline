import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";

import {
  getTranscriptionResult,
  getTranscriptionStatus,
} from "@/lib/recording/bootstrap-store";

export const runtime = "nodejs";

const app = new Hono().basePath("/api/transcriptions");

const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});

app.get(
  "/:sessionId/status",
  zValidator("param", sessionIdParamSchema),
  (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      return c.json(getTranscriptionStatus(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

app.get(
  "/:sessionId/result",
  zValidator("param", sessionIdParamSchema),
  (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      return c.json(getTranscriptionResult(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 404);
    }
  },
);

export const GET = handle(app);
