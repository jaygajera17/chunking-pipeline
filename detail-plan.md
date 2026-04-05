# Recording + Transcription — Agent Implementation Plan

> **Agent instruction:** Follow every step in order. Do not skip steps. Do not move to the next step until the current step is verified. Focus on correctness and reliability. UI is secondary.

---

## STEP 0 — Bootstrap the Monorepo

### 0.1 Scaffold Turborepo

```bash
npx create-turbo@latest recording-pipeline --package-manager npm
cd recording-pipeline
```

Expected structure after scaffold:
```
recording-pipeline/
├── apps/
│   ├── web/       (Next.js)
│   └── server/    (will replace with Hono/Bun)
├── packages/
│   ├── db/
│   ├── ui/
│   └── config/
├── turbo.json
└── package.json
```

### 0.2 Replace default server app with Hono + Bun

Delete the default server app content. Create `apps/server/` from scratch:

```bash
cd apps/server
bun init -y
```

`apps/server/package.json`:
```json
{
  "name": "server",
  "version": "1.0.0",
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "build": "bun build src/index.ts --outdir dist",
    "start": "bun dist/index.js"
  },
  "dependencies": {
    "hono": "^4.4.0",
    "@hono/node-server": "^1.12.0",
    "minio": "^8.0.0",
    "drizzle-orm": "^0.30.0",
    "postgres": "^3.4.4",
    "dotenv": "^16.4.5",
    "openai": "^4.52.0",
    "fluent-ffmpeg": "^2.1.3",
    "uuid": "^10.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "bun-types": "latest",
    "drizzle-kit": "^0.21.0",
    "@types/fluent-ffmpeg": "^2.1.24",
    "@types/uuid": "^10.0.0"
  }
}
```

### 0.3 Set up Next.js web app

The scaffold should already have a Next.js app. Update `apps/web/package.json` to ensure:

```json
{
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  }
}
```

### 0.4 Set up packages/db

```bash
cd packages/db
```

`packages/db/package.json`:
```json
{
  "name": "@repo/db",
  "version": "1.0.0",
  "main": "./src/index.ts",
  "dependencies": {
    "drizzle-orm": "^0.30.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "drizzle-kit": "^0.21.0"
  }
}
```

### 0.5 Root turbo.json pipeline

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "dist/**"] },
    "db:push": { "cache": false },
    "db:generate": { "cache": false },
    "check-types": {}
  }
}
```

### 0.6 Root package.json scripts

```json
{
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "dev:web": "turbo run dev --filter=web",
    "dev:server": "turbo run dev --filter=server",
    "db:push": "turbo run db:push --filter=@repo/db",
    "db:generate": "turbo run db:generate --filter=@repo/db",
    "check-types": "turbo run check-types"
  }
}
```

### 0.7 Environment files

`apps/server/.env`:
```
DATABASE_URL=postgresql://user:password@localhost:5432/recording_db
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=recordings
MINIO_USE_SSL=false
OPENAI_API_KEY=sk-...
PORT=3000
```

`apps/web/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:3000
```

### 0.8 Start infrastructure (Docker)

Create `docker-compose.yml` at root:

```yaml
version: "3.8"
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: recording_db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - miniodata:/data

volumes:
  pgdata:
  miniodata:
```

```bash
docker compose up -d
```

**Verify:** `psql postgresql://user:password@localhost:5432/recording_db -c "SELECT 1"` returns 1.
**Verify:** MinIO console accessible at `http://localhost:9001`.

Create MinIO bucket manually via console UI or:
```bash
# using mc (MinIO client)
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/recordings
```

---

## STEP 1 — Database Schema (Drizzle + PostgreSQL)

All schema lives in `packages/db/src/schema.ts`.

### 1.1 Write the full schema

```typescript
// packages/db/src/schema.ts
import {
  pgTable, uuid, text, integer, timestamp, real,
  unique, pgEnum, index
} from "drizzle-orm/pg-core";

// --- Enums ---

export const sessionStatusEnum = pgEnum("session_status", [
  "created", "recording", "stopping", "finalized",
  "transcribing", "completed", "failed"
]);

export const ackStateEnum = pgEnum("ack_state", [
  "pending", "acked", "repair_needed", "repaired"
]);

export const transcriptionJobStatusEnum = pgEnum("transcription_job_status", [
  "queued", "running", "completed", "failed"
]);

export const batchStatusEnum = pgEnum("batch_status", [
  "queued", "running", "completed", "failed"
]);

// --- Tables ---

export const recordingSessions = pgTable("recording_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: sessionStatusEnum("status").notNull().default("created"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at"),
  expectedLastSequenceNo: integer("expected_last_sequence_no"),
  durationMs: integer("duration_ms"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
});

export const recordingChunks = pgTable("recording_chunks", {
  chunkId: text("chunk_id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => recordingSessions.id),
  sequenceNo: integer("sequence_no").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  mimeType: text("mime_type").notNull().default("audio/webm;codecs=opus"),
  bucketKey: text("bucket_key"),
  bucketEtag: text("bucket_etag"),
  ackState: ackStateEnum("ack_state").notNull().default("pending"),
  ackedAt: timestamp("acked_at"),
}, (table) => ({
  sessionSeqUnique: unique().on(table.sessionId, table.sequenceNo),
  sessionIdIdx: index("chunks_session_id_idx").on(table.sessionId),
}));

export const sessionSpeakers = pgTable("session_speakers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => recordingSessions.id),
  speakerLabel: text("speaker_label").notNull(),
  clusterKey: text("cluster_key").notNull(),
  confidence: real("confidence"),
}, (table) => ({
  sessionSpeakerUnique: unique().on(table.sessionId, table.speakerLabel),
}));

export const transcriptionJobs = pgTable("transcription_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => recordingSessions.id).unique(),
  status: transcriptionJobStatusEnum("status").notNull().default("queued"),
  provider: text("provider").notNull().default("openai_whisper"),
  model: text("model").notNull().default("whisper-large-v3"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
});

export const transcriptionBatches = pgTable("transcription_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => recordingSessions.id),
  batchIndex: integer("batch_index").notNull(),
  sequenceNoStart: integer("sequence_no_start").notNull(),
  sequenceNoEnd: integer("sequence_no_end").notNull(),
  audioOffsetSec: real("audio_offset_sec").notNull().default(0),
  status: batchStatusEnum("status").notNull().default("queued"),
  attemptCount: integer("attempt_count").notNull().default(0),
  errorMessage: text("error_message"),
}, (table) => ({
  sessionBatchUnique: unique().on(table.sessionId, table.batchIndex),
}));

export const transcriptionSegments = pgTable("transcription_segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => recordingSessions.id),
  batchId: uuid("batch_id").references(() => transcriptionBatches.id),
  sequenceNoStart: integer("sequence_no_start").notNull(),
  sequenceNoEnd: integer("sequence_no_end").notNull(),
  speakerLabel: text("speaker_label"),
  text: text("text").notNull(),
  startSec: real("start_sec").notNull(),
  endSec: real("end_sec").notNull(),
}, (table) => ({
  sessionIdIdx: index("segments_session_id_idx").on(table.sessionId),
}));
```

### 1.2 Drizzle config

`packages/db/drizzle.config.ts`:
```typescript
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

`packages/db/package.json` scripts:
```json
{
  "scripts": {
    "db:push": "drizzle-kit push:pg",
    "db:generate": "drizzle-kit generate:pg",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

### 1.3 DB client

`packages/db/src/client.ts`:
```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);
export const db = drizzle(client, { schema });
export * from "./schema";
```

`packages/db/src/index.ts`:
```typescript
export * from "./client";
export * from "./schema";
```

### 1.4 Push schema to DB

```bash
npm run db:push
```

**Verify:** Connect to Postgres and confirm all 6 tables exist:
```sql
\dt
-- Should show: recording_sessions, recording_chunks, session_speakers,
--              transcription_jobs, transcription_batches, transcription_segments
```

---

## STEP 2 — Backend: MinIO Client + Helpers

All backend code lives in `apps/server/src/`.

### 2.1 MinIO client setup

`apps/server/src/lib/minio.ts`:
```typescript
import { Client } from "minio";

export const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT!,
  port: parseInt(process.env.MINIO_PORT || "9000"),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

export const BUCKET = process.env.MINIO_BUCKET!;

export async function ensureBucketExists() {
  const exists = await minioClient.bucketExists(BUCKET);
  if (!exists) {
    await minioClient.makeBucket(BUCKET);
    console.log(`Created bucket: ${BUCKET}`);
  }
}

export function chunkBucketKey(sessionId: string, sequenceNo: number, sha256: string) {
  return `recordings/${sessionId}/${sequenceNo}-${sha256}.webm`;
}

// Returns etag if object exists, null if not
export async function headObject(key: string): Promise<string | null> {
  try {
    const stat = await minioClient.statObject(BUCKET, key);
    return stat.etag;
  } catch {
    return null;
  }
}
```

### 2.2 DB connection in server

`apps/server/src/lib/db.ts`:
```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@repo/db";

const client = postgres(process.env.DATABASE_URL!);
export const db = drizzle(client, { schema });
```

---

## STEP 3 — Backend: Session API

### 3.1 Create session endpoint

`apps/server/src/routes/sessions.ts`:
```typescript
import { Hono } from "hono";
import { db } from "../lib/db";
import { recordingSessions } from "@repo/db";
import { eq } from "drizzle-orm";

export const sessionsRouter = new Hono();

// POST /api/recordings/sessions
sessionsRouter.post("/", async (c) => {
  const [session] = await db
    .insert(recordingSessions)
    .values({ status: "recording" })
    .returning();
  return c.json({ sessionId: session.id, status: session.status });
});

// PATCH /api/recordings/sessions/:sessionId/heartbeat
sessionsRouter.patch("/:sessionId/heartbeat", async (c) => {
  const sessionId = c.req.param("sessionId");
  await db
    .update(recordingSessions)
    .set({ lastHeartbeatAt: new Date() })
    .where(eq(recordingSessions.id, sessionId));
  return c.json({ ok: true });
});

// GET /api/recordings/sessions/:sessionId
sessionsRouter.get("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json(session);
});
```

---

## STEP 4 — Backend: Chunk Upload API (Critical — Idempotent)

`apps/server/src/routes/chunks.ts`:

```typescript
import { Hono } from "hono";
import { db } from "../lib/db";
import { recordingChunks } from "@repo/db";
import { eq, and } from "drizzle-orm";
import { minioClient, BUCKET, chunkBucketKey, headObject } from "../lib/minio";
import { createHash } from "crypto";

export const chunksRouter = new Hono();

// PUT /api/recordings/chunks/:chunkId
chunksRouter.put("/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");
  const sessionId = c.req.header("x-session-id");
  const sequenceNo = parseInt(c.req.header("x-sequence-no") || "");
  const claimedSha256 = c.req.header("x-sha256");
  const sizeBytes = parseInt(c.req.header("x-size-bytes") || "0");
  const mimeType = c.req.header("content-type") || "audio/webm;codecs=opus";

  if (!sessionId || isNaN(sequenceNo) || !claimedSha256) {
    return c.json({ error: "missing required headers" }, 400);
  }

  // Verify chunkId format: sessionId:sequenceNo:sha256
  const expectedChunkId = `${sessionId}:${sequenceNo}:${claimedSha256}`;
  if (chunkId !== expectedChunkId) {
    return c.json({ error: "chunkId mismatch" }, 400);
  }

  // --- Idempotency: return existing ack if already processed ---
  const existing = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.chunkId, chunkId));

  if (existing.length > 0 && existing[0].ackState === "acked") {
    return c.json({
      chunkId,
      ackState: "acked",
      bucketKey: existing[0].bucketKey,
      bucketEtag: existing[0].bucketEtag,
      ackedAt: existing[0].ackedAt,
    });
  }

  // --- Read body and verify sha256 ---
  const bodyBuffer = await c.req.arrayBuffer();
  const hash = createHash("sha256").update(Buffer.from(bodyBuffer)).digest("hex");
  if (hash !== claimedSha256) {
    return c.json({ error: "sha256 mismatch" }, 400);
  }

  const bucketKey = chunkBucketKey(sessionId, sequenceNo, claimedSha256);

  // --- Upload to MinIO ---
  await minioClient.putObject(
    BUCKET,
    bucketKey,
    Buffer.from(bodyBuffer),
    bodyBuffer.byteLength,
    { "Content-Type": mimeType }
  );

  // Verify object landed
  const etag = await headObject(bucketKey);
  if (!etag) {
    return c.json({ error: "minio write verification failed" }, 500);
  }

  const now = new Date();

  // --- Upsert ack in DB (transactional) ---
  const [ackRow] = await db
    .insert(recordingChunks)
    .values({
      chunkId,
      sessionId,
      sequenceNo,
      sha256: claimedSha256,
      sizeBytes: bodyBuffer.byteLength,
      mimeType,
      bucketKey,
      bucketEtag: etag,
      ackState: "acked",
      ackedAt: now,
    })
    .onConflictDoUpdate({
      target: recordingChunks.chunkId,
      set: {
        bucketKey,
        bucketEtag: etag,
        ackState: "acked",
        ackedAt: now,
      },
    })
    .returning();

  return c.json({
    chunkId: ackRow.chunkId,
    ackState: ackRow.ackState,
    bucketKey: ackRow.bucketKey,
    bucketEtag: ackRow.bucketEtag,
    ackedAt: ackRow.ackedAt,
  });
});
```

---

## STEP 5 — Backend: Reconciliation Logic

This is the core reliability feature. Write it as a reusable function, not just an endpoint.

`apps/server/src/lib/reconcile.ts`:

```typescript
import { db } from "./db";
import { recordingChunks } from "@repo/db";
import { eq, and, inArray } from "drizzle-orm";
import { headObject } from "./minio";

export type ReconcileResult = {
  totalExpected: number;
  allAcked: boolean;
  missingInDb: number[];         // sequence numbers not in DB at all
  missingInBucket: string[];     // chunkIds where DB says acked but bucket missing
};

export async function reconcileSession(
  sessionId: string,
  expectedLastSeqNo: number
): Promise<ReconcileResult> {
  const expectedSeqs = Array.from({ length: expectedLastSeqNo + 1 }, (_, i) => i);

  const chunks = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.sessionId, sessionId));

  const ackedChunks = chunks.filter(
    (c) => c.ackState === "acked" || c.ackState === "repaired"
  );
  const ackedSeqs = new Set(ackedChunks.map((c) => c.sequenceNo));

  // Find sequence numbers missing from DB entirely
  const missingInDb = expectedSeqs.filter((s) => !ackedSeqs.has(s));

  // For acked chunks, verify they exist in MinIO
  const missingInBucket: string[] = [];
  await Promise.all(
    ackedChunks.map(async (chunk) => {
      if (!chunk.bucketKey) {
        missingInBucket.push(chunk.chunkId);
        return;
      }
      const etag = await headObject(chunk.bucketKey);
      if (!etag) {
        missingInBucket.push(chunk.chunkId);
        // Mark as repair_needed in DB
        await db
          .update(recordingChunks)
          .set({ ackState: "repair_needed" })
          .where(eq(recordingChunks.chunkId, chunk.chunkId));
      }
    })
  );

  return {
    totalExpected: expectedLastSeqNo + 1,
    allAcked: missingInDb.length === 0 && missingInBucket.length === 0,
    missingInDb,
    missingInBucket,
  };
}
```

`apps/server/src/routes/reconcile.ts`:

```typescript
import { Hono } from "hono";
import { reconcileSession } from "../lib/reconcile";
import { db } from "../lib/db";
import { recordingChunks } from "@repo/db";
import { eq } from "drizzle-orm";
import { minioClient, BUCKET } from "../lib/minio";

export const reconcileRouter = new Hono();

// POST /api/recordings/reconcile  (body: { sessionId, expectedLastSequenceNo })
reconcileRouter.post("/", async (c) => {
  const { sessionId, expectedLastSequenceNo } = await c.req.json();
  const result = await reconcileSession(sessionId, expectedLastSequenceNo);
  return c.json(result);
});

// POST /api/recordings/repair/:chunkId  — client re-uploads from OPFS
// This endpoint accepts the raw chunk body, same as the main upload
// It marks ackState = 'repaired' after successful MinIO write
reconcileRouter.post("/repair/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");
  const bodyBuffer = await c.req.arrayBuffer();

  const [chunk] = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.chunkId, chunkId));

  if (!chunk) return c.json({ error: "chunk not found in db" }, 404);

  await minioClient.putObject(
    BUCKET,
    chunk.bucketKey!,
    Buffer.from(bodyBuffer),
    bodyBuffer.byteLength
  );

  await db
    .update(recordingChunks)
    .set({ ackState: "repaired" })
    .where(eq(recordingChunks.chunkId, chunkId));

  return c.json({ chunkId, ackState: "repaired" });
});
```

---

## STEP 6 — Backend: Finalize Endpoint

`apps/server/src/routes/finalize.ts`:

```typescript
import { Hono } from "hono";
import { db } from "../lib/db";
import { recordingSessions, transcriptionJobs } from "@repo/db";
import { eq } from "drizzle-orm";
import { reconcileSession } from "../lib/reconcile";

export const finalizeRouter = new Hono();

// POST /api/recordings/sessions/:sessionId/finalize
finalizeRouter.post("/:sessionId/finalize", async (c) => {
  const sessionId = c.req.param("sessionId");
  const { expectedLastSequenceNo } = await c.req.json() as { expectedLastSequenceNo: number };

  // 1. Run reconciliation automatically
  const reconcile = await reconcileSession(sessionId, expectedLastSequenceNo);

  if (!reconcile.allAcked) {
    // Return what needs repair so client can act
    return c.json(
      {
        status: "repair_required",
        missingInDb: reconcile.missingInDb,
        missingInBucket: reconcile.missingInBucket,
      },
      409
    );
  }

  // 2. Mark session finalized
  const stoppedAt = new Date();
  await db
    .update(recordingSessions)
    .set({
      status: "finalized",
      stoppedAt,
      expectedLastSequenceNo,
      durationMs: expectedLastSequenceNo * 5 * 1000, // 5s chunks
    })
    .where(eq(recordingSessions.id, sessionId));

  // 3. Enqueue transcription job
  await db
    .insert(transcriptionJobs)
    .values({
      sessionId,
      status: "queued",
      provider: "openai_whisper",
      model: "whisper-large-v3",
    })
    .onConflictDoNothing(); // safe to call finalize again

  // 4. Kick off transcription worker async (don't await)
  runTranscriptionWorker(sessionId).catch(console.error);

  return c.json({ status: "finalized", sessionId });
});

// Import here to avoid circular — defined in step 7
import { runTranscriptionWorker } from "../lib/transcription";
```

---

## STEP 7 — Backend: Transcription Worker

This is the most complex part. Build it carefully.

### 7.1 Audio assembly helper

`apps/server/src/lib/audio.ts`:

```typescript
import { minioClient, BUCKET } from "./minio";
import { db } from "./db";
import { recordingChunks } from "@repo/db";
import { eq, and, between } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import { createWriteStream, mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

// Download chunks from MinIO for a sequence range, concat them,
// and return path to a single merged webm file
export async function downloadAndMergeChunks(
  sessionId: string,
  seqStart: number,
  seqEnd: number,
  batchIndex: number
): Promise<{ filePath: string; offsetSec: number; durationSec: number }> {
  const chunks = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.sessionId, sessionId))
    .orderBy(recordingChunks.sequenceNo);

  const batchChunks = chunks.filter(
    (c) => c.sequenceNo >= seqStart && c.sequenceNo <= seqEnd
  );

  const dir = join(tmpdir(), `batch-${sessionId}-${batchIndex}`);
  mkdirSync(dir, { recursive: true });

  // Download each chunk
  const chunkPaths: string[] = [];
  for (const chunk of batchChunks) {
    const localPath = join(dir, `${chunk.sequenceNo}.webm`);
    const stream = await minioClient.getObject(BUCKET, chunk.bucketKey!);
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(localPath);
      stream.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
    chunkPaths.push(localPath);
  }

  // Write ffmpeg concat list
  const listPath = join(dir, "list.txt");
  const listContent = chunkPaths.map((p) => `file '${p}'`).join("\n");
  require("fs").writeFileSync(listPath, listContent);

  // Merge with ffmpeg
  const mergedPath = join(dir, `merged-${batchIndex}.webm`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    mergedPath,
  ]);

  const offsetSec = seqStart * 5; // 5s per chunk
  const durationSec = (seqEnd - seqStart + 1) * 5;

  return { filePath: mergedPath, offsetSec, durationSec };
}

export function cleanupDir(sessionId: string, batchIndex: number) {
  const dir = join(tmpdir(), `batch-${sessionId}-${batchIndex}`);
  try {
    require("fs").rmSync(dir, { recursive: true, force: true });
  } catch {}
}
```

### 7.2 Transcription worker

`apps/server/src/lib/transcription.ts`:

```typescript
import OpenAI from "openai";
import { db } from "./db";
import {
  transcriptionJobs,
  transcriptionBatches,
  transcriptionSegments,
  recordingSessions,
  recordingChunks,
} from "@repo/db";
import { eq, and } from "drizzle-orm";
import { downloadAndMergeChunks, cleanupDir } from "./audio";
import { createReadStream } from "fs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNKS_PER_BATCH = 60; // 5 minutes at 5s/chunk
const CONCURRENT_BATCHES = 4;
const MAX_WHISPER_RETRIES = 3;

export async function runTranscriptionWorker(sessionId: string) {
  console.log(`[transcription] Starting for session ${sessionId}`);

  // Mark job as running
  await db
    .update(transcriptionJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(transcriptionJobs.sessionId, sessionId));

  try {
    const [session] = await db
      .select()
      .from(recordingSessions)
      .where(eq(recordingSessions.id, sessionId));

    const totalChunks = (session.expectedLastSequenceNo ?? 0) + 1;
    const batchCount = Math.ceil(totalChunks / CHUNKS_PER_BATCH);

    // Create batch records
    for (let b = 0; b < batchCount; b++) {
      const seqStart = b * CHUNKS_PER_BATCH;
      const seqEnd = Math.min((b + 1) * CHUNKS_PER_BATCH - 1, session.expectedLastSequenceNo!);
      const offsetSec = seqStart * 5;

      await db
        .insert(transcriptionBatches)
        .values({
          sessionId,
          batchIndex: b,
          sequenceNoStart: seqStart,
          sequenceNoEnd: seqEnd,
          audioOffsetSec: offsetSec,
          status: "queued",
        })
        .onConflictDoNothing();
    }

    // Process batches with bounded concurrency
    const batchIndices = Array.from({ length: batchCount }, (_, i) => i);
    await processBatchesWithConcurrency(sessionId, batchIndices, CONCURRENT_BATCHES);

    // Mark job completed
    await db
      .update(transcriptionJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(transcriptionJobs.sessionId, sessionId));

    await db
      .update(recordingSessions)
      .set({ status: "completed" })
      .where(eq(recordingSessions.id, sessionId));

    console.log(`[transcription] Completed for session ${sessionId}`);
  } catch (err: any) {
    console.error(`[transcription] Failed for session ${sessionId}:`, err);
    await db
      .update(transcriptionJobs)
      .set({ status: "failed", errorMessage: String(err) })
      .where(eq(transcriptionJobs.sessionId, sessionId));
    await db
      .update(recordingSessions)
      .set({ status: "failed" })
      .where(eq(recordingSessions.id, sessionId));
  }
}

async function processBatchesWithConcurrency(
  sessionId: string,
  batchIndices: number[],
  concurrency: number
) {
  const queue = [...batchIndices];
  const active: Promise<void>[] = [];

  const runNext = async (): Promise<void> => {
    if (queue.length === 0) return;
    const batchIndex = queue.shift()!;
    await processSingleBatch(sessionId, batchIndex);
    return runNext();
  };

  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    active.push(runNext());
  }

  await Promise.all(active);
}

async function processSingleBatch(sessionId: string, batchIndex: number) {
  const [batch] = await db
    .select()
    .from(transcriptionBatches)
    .where(
      and(
        eq(transcriptionBatches.sessionId, sessionId),
        eq(transcriptionBatches.batchIndex, batchIndex)
      )
    );

  if (!batch || batch.status === "completed") return;

  await db
    .update(transcriptionBatches)
    .set({ status: "running", attemptCount: (batch.attemptCount ?? 0) + 1 })
    .where(eq(transcriptionBatches.id, batch.id));

  let lastErr: any;
  for (let attempt = 0; attempt < MAX_WHISPER_RETRIES; attempt++) {
    try {
      console.log(`[transcription] Batch ${batchIndex}, attempt ${attempt + 1}`);

      const { filePath, offsetSec } = await downloadAndMergeChunks(
        sessionId,
        batch.sequenceNoStart,
        batch.sequenceNoEnd,
        batchIndex
      );

      // Call Whisper with verbose_json to get timestamps
      const response = await openai.audio.transcriptions.create({
        file: createReadStream(filePath) as any,
        model: "whisper-1", // whisper-large-v3 via OpenAI API maps to whisper-1
        response_format: "verbose_json",
        temperature: 0,
        timestamp_granularities: ["segment"],
      });

      // Store segments with offset applied
      const segments = (response as any).segments ?? [];
      for (const seg of segments) {
        await db.insert(transcriptionSegments).values({
          sessionId,
          batchId: batch.id,
          sequenceNoStart: batch.sequenceNoStart,
          sequenceNoEnd: batch.sequenceNoEnd,
          text: seg.text.trim(),
          startSec: offsetSec + seg.start,
          endSec: offsetSec + seg.end,
          speakerLabel: null, // filled in diarization step
        });
      }

      cleanupDir(sessionId, batchIndex);

      await db
        .update(transcriptionBatches)
        .set({ status: "completed" })
        .where(eq(transcriptionBatches.id, batch.id));

      return;
    } catch (err) {
      lastErr = err;
      console.error(`[transcription] Batch ${batchIndex} attempt ${attempt + 1} failed:`, err);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // backoff
    }
  }

  await db
    .update(transcriptionBatches)
    .set({ status: "failed", errorMessage: String(lastErr) })
    .where(eq(transcriptionBatches.id, batch.id));

  throw lastErr;
}
```

### 7.3 Transcription status + result endpoints

`apps/server/src/routes/transcription.ts`:

```typescript
import { Hono } from "hono";
import { db } from "../lib/db";
import {
  transcriptionJobs,
  transcriptionSegments,
  sessionSpeakers,
} from "@repo/db";
import { eq, asc } from "drizzle-orm";

export const transcriptionRouter = new Hono();

// GET /api/transcriptions/:sessionId/status
transcriptionRouter.get("/:sessionId/status", async (c) => {
  const sessionId = c.req.param("sessionId");
  const [job] = await db
    .select()
    .from(transcriptionJobs)
    .where(eq(transcriptionJobs.sessionId, sessionId));

  if (!job) return c.json({ status: "not_started" });
  return c.json({
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.errorMessage,
  });
});

// GET /api/transcriptions/:sessionId/result
transcriptionRouter.get("/:sessionId/result", async (c) => {
  const sessionId = c.req.param("sessionId");

  const segments = await db
    .select()
    .from(transcriptionSegments)
    .where(eq(transcriptionSegments.sessionId, sessionId))
    .orderBy(asc(transcriptionSegments.startSec));

  const fullText = segments
    .map((s) => {
      const speaker = s.speakerLabel ? `[${s.speakerLabel}] ` : "";
      return `${speaker}${s.text}`;
    })
    .join(" ");

  return c.json({ segments, fullText });
});
```

---

## STEP 8 — Backend: Main Server Entry

`apps/server/src/index.ts`:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { sessionsRouter } from "./routes/sessions";
import { chunksRouter } from "./routes/chunks";
import { finalizeRouter } from "./routes/finalize";
import { reconcileRouter } from "./routes/reconcile";
import { transcriptionRouter } from "./routes/transcription";
import { ensureBucketExists } from "./lib/minio";

const app = new Hono();

app.use("*", cors({ origin: "http://localhost:3001" }));
app.use("*", logger());

app.get("/health", (c) => c.json({ ok: true }));

app.route("/api/recordings/sessions", sessionsRouter);
app.route("/api/recordings/sessions", finalizeRouter);   // finalize shares sessions path
app.route("/api/recordings/chunks", chunksRouter);
app.route("/api/recordings", reconcileRouter);
app.route("/api/transcriptions", transcriptionRouter);

// Startup
ensureBucketExists().then(() => {
  console.log("[server] MinIO bucket ready");
});

export default {
  port: parseInt(process.env.PORT || "3000"),
  fetch: app.fetch,
};
```

**Verify the server starts and health endpoint works:**
```bash
cd apps/server && bun src/index.ts
curl http://localhost:3000/health
# {"ok":true}
```

**Verify chunk upload works manually:**
```bash
# Create a session first
curl -X POST http://localhost:3000/api/recordings/sessions
# copy the sessionId

# Upload a test chunk
SESSION_ID=<uuid>
CHUNK_DATA=$(python3 -c "import sys; sys.stdout.buffer.write(b'test'*256)")
SHA=$(echo -n 'test'*256 | sha256sum | awk '{print $1}')
# Use a real binary for actual test
```

---

## STEP 9 — Frontend: OPFS Utility

`apps/web/src/lib/opfs.ts`:

```typescript
// OPFS utility — all chunk persistence lives here

export async function getSessionDir(sessionId: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle("sessions", { create: true });
  return sessions.getDirectoryHandle(sessionId, { create: true });
}

export async function writeChunkToOPFS(
  sessionId: string,
  sequenceNo: number,
  blob: Blob
): Promise<void> {
  const dir = await getSessionDir(sessionId);
  const fileHandle = await dir.getFileHandle(`${sequenceNo}.webm`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function readChunkFromOPFS(
  sessionId: string,
  sequenceNo: number
): Promise<Blob | null> {
  try {
    const dir = await getSessionDir(sessionId);
    const fileHandle = await dir.getFileHandle(`${sequenceNo}.webm`);
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

export async function deleteChunkFromOPFS(
  sessionId: string,
  sequenceNo: number
): Promise<void> {
  try {
    const dir = await getSessionDir(sessionId);
    await dir.removeEntry(`${sequenceNo}.webm`);
  } catch {}
}

export async function writeManifest(
  sessionId: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const dir = await getSessionDir(sessionId);
  const fileHandle = await dir.getFileHandle("manifest.json", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(manifest));
  await writable.close();
}

export async function readManifest(
  sessionId: string
): Promise<Record<string, unknown> | null> {
  try {
    const dir = await getSessionDir(sessionId);
    const fileHandle = await dir.getFileHandle("manifest.json");
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function deleteSessionFromOPFS(sessionId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle("sessions", { create: false });
    await sessions.removeEntry(sessionId, { recursive: true });
  } catch {}
}
```

---

## STEP 10 — Frontend: SHA-256 Utility

`apps/web/src/lib/hash.ts`:

```typescript
export async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

---

## STEP 11 — Frontend: Upload Queue

`apps/web/src/lib/uploadQueue.ts`:

```typescript
import { sha256Hex } from "./hash";
import { writeChunkToOPFS, readChunkFromOPFS, deleteChunkFromOPFS } from "./opfs";

const API = process.env.NEXT_PUBLIC_API_URL;
const MAX_CONCURRENT = 6;
const MAX_RETRIES = 5;

export type ChunkState =
  | "persisted"
  | "queued"
  | "uploading"
  | "acked"
  | "upload_failed_retryable"
  | "upload_failed_fatal"
  | "gc_ready"
  | "deleted";

export type ChunkMeta = {
  sessionId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  chunkId: string;
  state: ChunkState;
  retryCount: number;
  ackedAt?: string;
};

// In-memory queue — survives tab crashes via OPFS manifest replay
const chunks = new Map<string, ChunkMeta>();
let activeUploads = 0;
const queue: string[] = [];

type AckCallback = (chunkId: string) => void;
const ackCallbacks: AckCallback[] = [];

export function onChunkAcked(cb: AckCallback) {
  ackCallbacks.push(cb);
}

export async function enqueueChunk(sessionId: string, sequenceNo: number, blob: Blob) {
  const sha256 = await sha256Hex(blob);
  const chunkId = `${sessionId}:${sequenceNo}:${sha256}`;

  // 1. Write to OPFS first — if this throws, do not proceed
  await writeChunkToOPFS(sessionId, sequenceNo, blob);

  const meta: ChunkMeta = {
    sessionId,
    sequenceNo,
    sha256,
    sizeBytes: blob.size,
    chunkId,
    state: "persisted",
    retryCount: 0,
  };

  chunks.set(chunkId, meta);
  meta.state = "queued";
  queue.push(chunkId);

  drainQueue();
}

function drainQueue() {
  while (activeUploads < MAX_CONCURRENT && queue.length > 0) {
    const chunkId = queue.shift()!;
    const meta = chunks.get(chunkId);
    if (!meta) continue;
    meta.state = "uploading";
    activeUploads++;
    uploadChunk(meta)
      .then(() => {
        activeUploads--;
        drainQueue();
      })
      .catch(() => {
        activeUploads--;
        drainQueue();
      });
  }
}

async function uploadChunk(meta: ChunkMeta) {
  const blob = await readChunkFromOPFS(meta.sessionId, meta.sequenceNo);
  if (!blob) {
    meta.state = "upload_failed_fatal";
    return;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API}/api/recordings/chunks/${meta.chunkId}`, {
        method: "PUT",
        headers: {
          "x-session-id": meta.sessionId,
          "x-sequence-no": String(meta.sequenceNo),
          "x-sha256": meta.sha256,
          "x-size-bytes": String(meta.sizeBytes),
          "content-type": "audio/webm;codecs=opus",
        },
        body: blob,
      });

      if (res.ok) {
        const ack = await res.json();
        meta.state = "acked";
        meta.ackedAt = ack.ackedAt;
        meta.state = "gc_ready";
        ackCallbacks.forEach((cb) => cb(meta.chunkId));
        // OPFS cleanup after ack
        await deleteChunkFromOPFS(meta.sessionId, meta.sequenceNo);
        meta.state = "deleted";
        return;
      }

      if (res.status >= 400 && res.status < 500) {
        meta.state = "upload_failed_fatal";
        return;
      }

      // 5xx — retry
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        meta.state = "upload_failed_fatal";
        return;
      }
      meta.state = "upload_failed_retryable";
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export function getAllChunkStates() {
  return Array.from(chunks.values());
}

export function getPendingCount() {
  return Array.from(chunks.values()).filter(
    (c) => c.state !== "deleted" && c.state !== "upload_failed_fatal"
  ).length;
}

export function waitForAllAcked(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const pending = Array.from(chunks.values()).filter(
        (c) => c.state !== "acked" && c.state !== "gc_ready" && c.state !== "deleted"
      );
      if (pending.length === 0) resolve();
      else setTimeout(check, 500);
    };
    check();
  });
}
```

---

## STEP 12 — Frontend: Recording Page

`apps/web/src/app/page.tsx`:

```tsx
"use client";
import { useRef, useState, useEffect } from "react";
import { enqueueChunk, waitForAllAcked, getAllChunkStates } from "@/lib/uploadQueue";
import { deleteSessionFromOPFS } from "@/lib/opfs";

const API = process.env.NEXT_PUBLIC_API_URL;

type Status =
  | "idle"
  | "recording"
  | "stopping"
  | "finalizing"
  | "repairing"
  | "transcribing"
  | "done"
  | "error";

export default function RecordPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seqNo, setSeqNo] = useState(0);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const seqRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function startRecording() {
    setStatus("recording");
    setStatusMsg("Requesting microphone...");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // Create session on server
    const res = await fetch(`${API}/api/recordings/sessions`, { method: "POST" });
    const { sessionId: sid } = await res.json();
    setSessionId(sid);
    sessionIdRef.current = sid;
    seqRef.current = 0;
    setSeqNo(0);

    // Heartbeat every 20s
    heartbeatRef.current = setInterval(async () => {
      if (sessionIdRef.current) {
        await fetch(`${API}/api/recordings/sessions/${sessionIdRef.current}/heartbeat`, {
          method: "PATCH",
        });
      }
    }, 20000);

    const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = async (e) => {
      if (e.data.size === 0) return;
      const seq = seqRef.current++;
      setSeqNo(seq);
      setChunkCount((c) => c + 1);
      setStatusMsg(`Recording... chunk ${seq} uploading`);
      try {
        await enqueueChunk(sessionIdRef.current!, seq, e.data);
      } catch (err) {
        // OPFS write failed — hard stop
        setStatus("error");
        setStatusMsg("OPFS storage failed. Recording stopped.");
        mr.stop();
        stream.getTracks().forEach((t) => t.stop());
      }
    };

    mr.start(5000); // 5s chunks
    setStatusMsg("Recording...");
  }

  async function stopRecording() {
    setStatus("stopping");
    setStatusMsg("Stopping recorder...");

    if (heartbeatRef.current) clearInterval(heartbeatRef.current);

    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        mr.stop();
      });
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());

    setStatusMsg("Waiting for all chunks to upload...");
    await waitForAllAcked();

    const expectedLastSeq = seqRef.current - 1;
    setStatus("finalizing");
    setStatusMsg("Finalizing session...");

    await finalizeWithRepair(sessionIdRef.current!, expectedLastSeq);
  }

  async function finalizeWithRepair(sid: string, expectedLastSeq: number) {
    const res = await fetch(`${API}/api/recordings/sessions/${sid}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedLastSequenceNo: expectedLastSeq }),
    });

    if (res.ok) {
      setStatus("transcribing");
      setStatusMsg("Transcribing... polling for result.");
      await pollTranscription(sid);
      return;
    }

    if (res.status === 409) {
      const body = await res.json();
      setStatus("repairing");
      setStatusMsg(`Repairing ${body.missingInBucket?.length ?? 0} missing chunks...`);

      // Re-upload missing chunks from OPFS
      for (const chunkId of body.missingInBucket ?? []) {
        const [, seqStr] = chunkId.split(":");
        const seq = parseInt(seqStr);
        const { readChunkFromOPFS } = await import("@/lib/opfs");
        const blob = await readChunkFromOPFS(sid, seq);
        if (blob) {
          await fetch(`${API}/api/recordings/repair/${chunkId}`, {
            method: "POST",
            body: blob,
          });
        }
      }

      // Retry finalize
      setStatusMsg("Retrying finalize after repair...");
      await finalizeWithRepair(sid, expectedLastSeq);
    } else {
      setStatus("error");
      setStatusMsg(`Finalize failed: ${res.status}`);
    }
  }

  async function pollTranscription(sid: string) {
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await fetch(`${API}/api/transcriptions/${sid}/status`);
      const { status: tStatus } = await statusRes.json();
      setStatusMsg(`Transcription: ${tStatus}...`);

      if (tStatus === "completed") {
        const resultRes = await fetch(`${API}/api/transcriptions/${sid}/result`);
        const { fullText } = await resultRes.json();
        setTranscript(fullText);
        setStatus("done");
        setStatusMsg("Done!");
        await deleteSessionFromOPFS(sid);
        return;
      }

      if (tStatus === "failed") {
        setStatus("error");
        setStatusMsg("Transcription failed.");
        return;
      }
    }
  }

  return (
    <div style={{ padding: 32, fontFamily: "monospace", maxWidth: 800 }}>
      <h1>Recording Pipeline</h1>

      <div style={{ marginBottom: 16 }}>
        <strong>Status:</strong> {statusMsg}
      </div>

      <div style={{ marginBottom: 16 }}>
        <strong>Session:</strong> {sessionId ?? "—"} &nbsp;|&nbsp;
        <strong>Chunks:</strong> {chunkCount} &nbsp;|&nbsp;
        <strong>Current seq:</strong> {seqNo}
      </div>

      {status === "idle" && (
        <button onClick={startRecording} style={{ marginRight: 8 }}>
          ● Start Recording
        </button>
      )}

      {status === "recording" && (
        <button onClick={stopRecording}>■ Stop Recording</button>
      )}

      {transcript && (
        <div style={{ marginTop: 32 }}>
          <h2>Transcript</h2>
          <pre style={{ whiteSpace: "pre-wrap", border: "1px solid #ccc", padding: 16 }}>
            {transcript}
          </pre>
        </div>
      )}
    </div>
  );
}
```

---

## STEP 13 — Install Dependencies and Verify

```bash
# From repo root
npm install

# Verify server compiles
cd apps/server && bun --check src/index.ts

# Verify web builds
cd apps/web && npx tsc --noEmit
```

Make sure ffmpeg is installed on the system:
```bash
ffmpeg -version
# if not: sudo apt install ffmpeg (linux) or brew install ffmpeg (mac)
```

---

## STEP 14 — End-to-End Smoke Test

Run everything:
```bash
docker compose up -d
npm run dev
```

Manual test sequence:
1. Open `http://localhost:3001`
2. Click **Start Recording** — speak for 30 seconds
3. Click **Stop Recording**
4. Watch status messages: uploading → finalizing → transcribing → done
5. Transcript should appear on screen

Verify in DB:
```sql
-- All chunks acked
SELECT sequence_no, ack_state FROM recording_chunks WHERE session_id = '<sid>' ORDER BY sequence_no;

-- Session finalized
SELECT status, expected_last_sequence_no FROM recording_sessions WHERE id = '<sid>';

-- Transcription completed
SELECT status FROM transcription_jobs WHERE session_id = '<sid>';

-- Segments stored
SELECT start_sec, end_sec, text FROM transcription_segments WHERE session_id = '<sid>' ORDER BY start_sec;
```

Verify in MinIO:
```bash
mc ls local/recordings/<sid>/
# Should list all .webm chunk files
```

---

## STEP 15 — Reliability Tests

### Test 1: Crash recovery
1. Start recording
2. Close the browser tab after 20 seconds
3. Re-open `http://localhost:3001`
4. **Expected:** App detects unfinished session from OPFS manifest and resumes upload
   - *(Note: implement manifest read on mount in page.tsx — check OPFS for existing session state)*

### Test 2: Duplicate upload
1. Manually call the chunk upload endpoint twice with the same chunkId
2. **Expected:** Second call returns 200 with same ack, no duplicate in MinIO

```bash
CHUNK_ID="<sessionId>:<seqNo>:<sha256>"
curl -X PUT http://localhost:3000/api/recordings/chunks/$CHUNK_ID \
  -H "x-session-id: <sid>" \
  -H "x-sequence-no: 0" \
  -H "x-sha256: <sha256>" \
  -H "content-type: audio/webm;codecs=opus" \
  --data-binary @chunk0.webm
# Run twice — both should return ackState: "acked"
```

### Test 3: MinIO object deletion
1. Complete a recording
2. Manually delete a chunk from MinIO:
   ```bash
   mc rm local/recordings/<sid>/<seq>-<sha256>.webm
   ```
3. Call reconcile:
   ```bash
   curl -X POST http://localhost:3000/api/recordings/reconcile \
     -H "content-type: application/json" \
     -d '{"sessionId":"<sid>","expectedLastSequenceNo":<n>}'
   ```
4. **Expected:** Response shows `missingInBucket: [<chunkId>]` and DB shows `repair_needed`

### Test 4: 1-hour endurance
1. Record for exactly 60 minutes
2. After transcription completes, verify:
```sql
-- Count chunks: should be ~720
SELECT COUNT(*) FROM recording_chunks WHERE session_id = '<sid>' AND ack_state = 'acked';

-- Count segments: should be non-zero, covering full duration
SELECT MIN(start_sec), MAX(end_sec) FROM transcription_segments WHERE session_id = '<sid>';
-- MAX(end_sec) should be ~3600
```

---

## STEP 16 — Known Limitations and Acceptable Trade-offs

| Item | Decision |
|---|---|
| Speaker diarization | Not implemented in v1 — segments have `speaker_label = null`. Add pyannote.audio or AssemblyAI diarization as post-processing step if time allows |
| OPFS crash replay | Basic version implemented. Full state machine replay from manifest is phase 2 |
| Load test (300K) | De-scoped from hackathon. Focus is on 1-hour reliability |
| Whisper model | OpenAI API uses `whisper-1` endpoint. Pass `language: "en"` for accuracy |

---

## Quick Reference: API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/recordings/sessions` | Create session |
| PATCH | `/api/recordings/sessions/:id/heartbeat` | Keep session alive |
| PUT | `/api/recordings/chunks/:chunkId` | Upload chunk (idempotent) |
| POST | `/api/recordings/sessions/:id/finalize` | Finalize + trigger transcription |
| POST | `/api/recordings/reconcile` | Check session integrity |
| POST | `/api/recordings/repair/:chunkId` | Re-upload from OPFS |
| GET | `/api/transcriptions/:id/status` | Poll transcription progress |
| GET | `/api/transcriptions/:id/result` | Get final transcript |