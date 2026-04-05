import { createHash, randomUUID } from "crypto";

import { and, asc, eq, gte, lte } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  recordingChunks,
  recordingSessions,
  transcriptionJobs,
  transcriptionSegments,
} from "@/lib/db/schema";
import {
  ensureRecordingBucketExists,
  getChunkBucketKey,
  getMinioClient,
  getRecordingBucketName,
  statObjectIfExists,
} from "@/lib/storage/minio";

type UploadChunkInput = {
  chunkId: string;
  sessionId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  payloadBuffer: Buffer;
};

// Bootstrap speaker mapping used until real diarization is added.
function buildSpeakerLabel(sequenceNo: number) {
  return sequenceNo % 2 === 0 ? "User1" : "User2";
}

// Simulates asynchronous transcription and writes placeholder segments.
async function runBootstrapTranscription(sessionId: string) {
  const db = getDb();

  await db
    .update(recordingSessions)
    .set({ status: "transcribing" })
    .where(eq(recordingSessions.id, sessionId));

  await db
    .update(transcriptionJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(transcriptionJobs.sessionId, sessionId));

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const chunks = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.sessionId, sessionId))
    .orderBy(asc(recordingChunks.sequenceNo));

  await db
    .delete(transcriptionSegments)
    .where(eq(transcriptionSegments.sessionId, sessionId));

  if (chunks.length > 0) {
    await db.insert(transcriptionSegments).values(
      chunks.map((chunk) => ({
        id: randomUUID(),
        sessionId,
        sequenceNoStart: chunk.sequenceNo,
        sequenceNoEnd: chunk.sequenceNo,
        speakerLabel: buildSpeakerLabel(chunk.sequenceNo),
        text: `Transcribed chunk ${chunk.sequenceNo}`,
        startSec: chunk.sequenceNo * 5,
        endSec: chunk.sequenceNo * 5 + 5,
      })),
    );
  }

  await db
    .update(transcriptionJobs)
    .set({ status: "completed", completedAt: new Date(), errorMessage: null })
    .where(eq(transcriptionJobs.sessionId, sessionId));

  await db
    .update(recordingSessions)
    .set({ status: "completed" })
    .where(eq(recordingSessions.id, sessionId));
}

// Schedules bootstrap transcription without blocking the request lifecycle.
function enqueueBootstrapTranscription(sessionId: string) {
  queueMicrotask(() => {
    void runBootstrapTranscription(sessionId).catch(async (error) => {
      const db = getDb();
      const message = error instanceof Error ? error.message : "Unknown error";

      await db
        .update(transcriptionJobs)
        .set({ status: "failed", errorMessage: message })
        .where(eq(transcriptionJobs.sessionId, sessionId));

      await db
        .update(recordingSessions)
        .set({ status: "failed" })
        .where(eq(recordingSessions.id, sessionId));
    });
  });
}

export async function createSessionRecord() {
  // Creates a new session and puts it directly into recording state.
  const db = getDb();

  const [session] = await db
    .insert(recordingSessions)
    .values({ status: "recording" })
    .returning();

  return session;
}

// Returns basic heartbeat data and validates that the session exists.
export async function heartbeatSessionRecord(sessionId: string) {
  const db = getDb();

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  return {
    sessionId,
    status: session.status,
    heartbeatAt: new Date().toISOString(),
  };
}

// Performs deterministic validation, durable object write, and DB ack upsert.
export async function uploadChunkWithDurability(input: UploadChunkInput) {
  const db = getDb();

  const expectedChunkId = `${input.sessionId}:${input.sequenceNo}:${input.sha256}`;
  if (input.chunkId !== expectedChunkId) {
    throw new Error("chunk_id does not match deterministic identity rule");
  }

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, input.sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  const payloadSha256 = createHash("sha256")
    .update(input.payloadBuffer)
    .digest("hex");

  if (payloadSha256 !== input.sha256) {
    throw new Error("sha256 mismatch");
  }

  const [existingChunk] = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.chunkId, input.chunkId))
    .limit(1);

  if (existingChunk && existingChunk.ackState === "acked") {
    return {
      duplicate: true,
      chunk: existingChunk,
    };
  }

  await ensureRecordingBucketExists();

  const bucketName = getRecordingBucketName();
  const minioClient = getMinioClient();
  const bucketKey = getChunkBucketKey(
    input.sessionId,
    input.sequenceNo,
    input.sha256,
  );

  await minioClient.putObject(
    bucketName,
    bucketKey,
    input.payloadBuffer,
    input.payloadBuffer.byteLength,
    {
      "Content-Type": input.mimeType,
    },
  );

  const stat = await statObjectIfExists(bucketKey);
  if (!stat) {
    throw new Error("Object not found after upload");
  }

  const now = new Date();

  const [chunk] = await db
    .insert(recordingChunks)
    .values({
      chunkId: input.chunkId,
      sessionId: input.sessionId,
      sequenceNo: input.sequenceNo,
      sha256: input.sha256,
      sizeBytes: input.payloadBuffer.byteLength,
      mimeType: input.mimeType,
      bucketKey,
      bucketEtag: stat.etag,
      ackState: "acked",
      ackedAt: now,
    })
    .onConflictDoUpdate({
      target: recordingChunks.chunkId,
      set: {
        sizeBytes: input.payloadBuffer.byteLength,
        mimeType: input.mimeType,
        bucketKey,
        bucketEtag: stat.etag,
        ackState: "acked",
        ackedAt: now,
      },
    })
    .returning();

  return {
    duplicate: !!existingChunk,
    chunk,
  };
}

// Verifies contiguous sequence coverage and object presence for a range.
export async function reconcileSessionRange(
  sessionId: string,
  sequenceNoStart: number,
  sequenceNoEnd: number,
) {
  const db = getDb();

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  const chunkRows = await db
    .select()
    .from(recordingChunks)
    .where(
      and(
        eq(recordingChunks.sessionId, sessionId),
        gte(recordingChunks.sequenceNo, sequenceNoStart),
        lte(recordingChunks.sequenceNo, sequenceNoEnd),
      ),
    );

  const bySequence = new Map(
    chunkRows.map((chunk) => [chunk.sequenceNo, chunk]),
  );

  const missingSequences: number[] = [];
  const missingChunkIds: string[] = [];

  for (
    let sequenceNo = sequenceNoStart;
    sequenceNo <= sequenceNoEnd;
    sequenceNo += 1
  ) {
    const chunk = bySequence.get(sequenceNo);

    if (!chunk) {
      missingSequences.push(sequenceNo);
      continue;
    }

    if (chunk.ackState !== "acked" && chunk.ackState !== "repaired") {
      missingSequences.push(sequenceNo);
      continue;
    }

    const objectStat = await statObjectIfExists(chunk.bucketKey);
    if (!objectStat) {
      missingChunkIds.push(chunk.chunkId);

      await db
        .update(recordingChunks)
        .set({ ackState: "repair_needed" })
        .where(eq(recordingChunks.chunkId, chunk.chunkId));
    }
  }

  return {
    sessionId,
    sequenceNoStart,
    sequenceNoEnd,
    missingSequences,
    missingChunkIds,
    repairRequired: missingSequences.length > 0 || missingChunkIds.length > 0,
  };
}

// Re-uploads a single chunk from client payload and marks it repaired.
export async function repairChunkFromPayload(
  chunkId: string,
  payloadBuffer: Buffer,
) {
  const db = getDb();

  const [chunk] = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.chunkId, chunkId))
    .limit(1);

  if (!chunk) {
    throw new Error("Chunk not found");
  }

  await ensureRecordingBucketExists();

  const minioClient = getMinioClient();
  const bucketName = getRecordingBucketName();

  await minioClient.putObject(
    bucketName,
    chunk.bucketKey,
    payloadBuffer,
    payloadBuffer.byteLength,
    { "Content-Type": chunk.mimeType },
  );

  const stat = await statObjectIfExists(chunk.bucketKey);
  if (!stat) {
    throw new Error("Object not found after repair upload");
  }

  const [repairedChunk] = await db
    .update(recordingChunks)
    .set({
      ackState: "repaired",
      ackedAt: new Date(),
      bucketEtag: stat.etag,
      sizeBytes: payloadBuffer.byteLength,
    })
    .where(eq(recordingChunks.chunkId, chunkId))
    .returning();

  return repairedChunk;
}

// Finalizes only after clean reconciliation and enqueues transcription work.
export async function finalizeSessionRecord(
  sessionId: string,
  expectedLastSequenceNo: number,
) {
  const db = getDb();

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  await db
    .update(recordingSessions)
    .set({ status: "stopping" })
    .where(eq(recordingSessions.id, sessionId));

  const reconciliation = await reconcileSessionRange(
    sessionId,
    0,
    expectedLastSequenceNo,
  );

  if (reconciliation.repairRequired) {
    return {
      finalized: false,
      sessionId,
      status: "repair_required" as const,
      missingSequences: reconciliation.missingSequences,
      missingChunkIds: reconciliation.missingChunkIds,
    };
  }

  const stoppedAt = new Date();
  const startedAtMs = new Date(session.startedAt).getTime();

  await db
    .update(recordingSessions)
    .set({
      status: "finalized",
      stoppedAt,
      expectedLastSequenceNo,
      durationMs: stoppedAt.getTime() - startedAtMs,
    })
    .where(eq(recordingSessions.id, sessionId));

  await db
    .insert(transcriptionJobs)
    .values({
      sessionId,
      status: "queued",
      provider: "openai_whisper",
      model: "whisper-large-v3",
    })
    .onConflictDoNothing();

  enqueueBootstrapTranscription(sessionId);

  return {
    finalized: true,
    sessionId,
    status: "finalized" as const,
    expectedLastSequenceNo,
  };
}

// Returns durable transcription job status with segment count metadata.
export async function getTranscriptionStatusForSession(sessionId: string) {
  const db = getDb();

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  const [job] = await db
    .select()
    .from(transcriptionJobs)
    .where(eq(transcriptionJobs.sessionId, sessionId))
    .limit(1);

  if (!job) {
    return {
      sessionId,
      status: "not_started" as const,
    };
  }

  const segments = await db
    .select({ id: transcriptionSegments.id })
    .from(transcriptionSegments)
    .where(eq(transcriptionSegments.sessionId, sessionId));

  return {
    sessionId,
    status: job.status,
    provider: job.provider,
    model: job.model,
    segmentCount: segments.length,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    errorMessage: job.errorMessage,
  };
}

// Returns transcription status plus ordered segments and speaker summary.
export async function getTranscriptionResultForSession(sessionId: string) {
  const db = getDb();

  const status = await getTranscriptionStatusForSession(sessionId);

  const segments = await db
    .select()
    .from(transcriptionSegments)
    .where(eq(transcriptionSegments.sessionId, sessionId))
    .orderBy(asc(transcriptionSegments.startSec));

  const speakers = [
    ...new Set(segments.map((segment) => segment.speakerLabel)),
  ];

  return {
    ...status,
    speakers,
    segments,
  };
}
