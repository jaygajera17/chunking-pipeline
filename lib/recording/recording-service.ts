import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { createWriteStream } from "fs";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { pipeline } from "stream/promises";

import { and, asc, eq, gte, lte } from "drizzle-orm";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { getDb } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import {
  recordingChunks,
  recordingSessions,
  sessionSpeakers,
  transcriptionBatches,
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

const execFileAsync = promisify(execFile);
const CHUNK_DURATION_SECONDS = 5;
const CHUNKS_PER_BATCH = 60;
const TRANSCRIPTION_CONCURRENCY = 4;
const MAX_BATCH_ATTEMPTS = 3;
const MIN_ACCEPTABLE_COVERAGE_RATIO = 0.35;

let openaiClient: OpenAI | null = null;
let resolvedFfmpegCommand: string | null = null;

type UploadChunkInput = {
  chunkId: string;
  sessionId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  payloadBuffer: Buffer;
};

type TranscribedSegment = {
  text: string;
  startSec: number;
  endSec: number;
};

// Placeholder speaker mapping until diarization integration is added.
function buildSpeakerLabel(segmentIndex: number) {
  return segmentIndex % 2 === 0 ? "User1" : "User2";
}

function getOpenAiClient() {
  if (openaiClient) {
    return openaiClient;
  }

  const env = getServerEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for transcription");
  }

  openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openaiClient;
}

function resolveWhisperModel() {
  const env = getServerEnv();

  // OpenAI transcription API currently uses whisper-1; keep config compatibility.
  if (env.OPENAI_WHISPER_MODEL === "whisper-large-v3") {
    return "whisper-1";
  }

  return env.OPENAI_WHISPER_MODEL;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function tryResolveWingetFfmpegPath() {
  // Winget installs FFmpeg outside PATH in some shells, so probe known install roots.
  if (process.platform !== "win32") {
    return null;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const packagesRoot = join(localAppData, "Microsoft", "WinGet", "Packages");

  let packageDirs: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    packageDirs = (await readdir(packagesRoot, {
      withFileTypes: true,
      encoding: "utf8",
    })) as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return null;
  }

  const ffmpegPackageCandidates = packageDirs
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("Gyan.FFmpeg_"),
    )
    .map((entry) => join(packagesRoot, entry.name));

  for (const packageDir of ffmpegPackageCandidates) {
    let extractedDirs: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      extractedDirs = (await readdir(packageDir, {
        withFileTypes: true,
        encoding: "utf8",
      })) as Array<{ name: string; isDirectory: () => boolean }>;
    } catch {
      continue;
    }

    for (const extractedDir of extractedDirs) {
      if (!extractedDir.isDirectory()) {
        continue;
      }

      const ffmpegExePath = join(
        packageDir,
        extractedDir.name,
        "bin",
        "ffmpeg.exe",
      );

      try {
        await access(ffmpegExePath);
        return ffmpegExePath;
      } catch {
        // Keep searching for other extracted directories.
      }
    }
  }

  return null;
}

async function resolveFfmpegCommand() {
  // Resolve once and cache to avoid shelling out per batch.
  if (resolvedFfmpegCommand) {
    return resolvedFfmpegCommand;
  }

  const explicitFfmpegPath = process.env.FFMPEG_PATH?.trim();
  if (explicitFfmpegPath) {
    try {
      await execFileAsync(explicitFfmpegPath, ["-version"]);
      resolvedFfmpegCommand = explicitFfmpegPath;
      return resolvedFfmpegCommand;
    } catch {
      // Continue with other resolution attempts.
    }
  }

  try {
    await execFileAsync("ffmpeg", ["-version"]);
    resolvedFfmpegCommand = "ffmpeg";
    return resolvedFfmpegCommand;
  } catch {
    // Continue with Winget path fallback.
  }

  const wingetFfmpegPath = await tryResolveWingetFfmpegPath();
  if (wingetFfmpegPath) {
    resolvedFfmpegCommand = wingetFfmpegPath;
    return resolvedFfmpegCommand;
  }

  throw new Error(
    "FFmpeg executable not found. Install FFmpeg or set FFMPEG_PATH.",
  );
}

async function saveReadableStreamToFile(
  source: NodeJS.ReadableStream,
  destinationPath: string,
) {
  const destination = createWriteStream(destinationPath);
  await pipeline(source, destination);
}

async function runFfmpegTranscodeToWav(inputPath: string, outputPath: string) {
  const ffmpegCommand = await resolveFfmpegCommand();

  await execFileAsync(ffmpegCommand, [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);
}

async function concatFilesBinary(inputPaths: string[], outputPath: string) {
  // Browser MediaRecorder chunks are appendable byte segments for this pipeline.
  await writeFile(outputPath, Buffer.alloc(0));

  for (const inputPath of inputPaths) {
    const chunkBytes = await readFile(inputPath);
    await appendFile(outputPath, chunkBytes);
  }
}

function getSegmentsCoverageSeconds(segments: TranscribedSegment[]) {
  if (segments.length === 0) {
    return 0;
  }

  return (
    Math.max(...segments.map((segment) => segment.endSec)) -
    Math.min(...segments.map((segment) => segment.startSec))
  );
}

function toSequenceNoFromSecond(second: number) {
  return Math.max(0, Math.floor(second / CHUNK_DURATION_SECONDS));
}

async function transcribeSingleFile(
  filePath: string,
  offsetSec: number,
  fileName: string,
  contentType: string,
): Promise<TranscribedSegment[]> {
  const model = resolveWhisperModel();
  const client = getOpenAiClient();
  const fileBuffer = await readFile(filePath);
  const uploadFile = await toFile(fileBuffer, fileName, {
    type: contentType,
  });

  const response = (await client.audio.transcriptions.create({
    file: uploadFile,
    model,
    response_format: "verbose_json",
    temperature: 0,
    timestamp_granularities: ["segment"],
  } as never)) as {
    text?: string;
    segments?: Array<{ text?: string; start?: number; end?: number }>;
  };

  const segments = response.segments ?? [];
  if (segments.length === 0) {
    const fallbackText = (response.text ?? "").trim();
    if (!fallbackText) {
      return [];
    }

    return [
      {
        text: fallbackText,
        startSec: offsetSec,
        endSec: offsetSec + CHUNK_DURATION_SECONDS,
      },
    ];
  }

  return segments
    .map((segment) => {
      const rawText = (segment.text ?? "").trim();
      if (!rawText) {
        return null;
      }

      const rawStart = Number(segment.start ?? 0);
      const rawEnd = Number(segment.end ?? rawStart + 0.1);

      return {
        text: rawText,
        startSec: offsetSec + Math.max(0, rawStart),
        endSec: offsetSec + Math.max(rawEnd, rawStart + 0.05),
      };
    })
    .filter((segment): segment is TranscribedSegment => !!segment);
}

async function downloadBatchChunkFiles(
  sessionId: string,
  sequenceNoStart: number,
  sequenceNoEnd: number,
) {
  const db = getDb();

  const chunkRows = await db
    .select()
    .from(recordingChunks)
    .where(
      and(
        eq(recordingChunks.sessionId, sessionId),
        gte(recordingChunks.sequenceNo, sequenceNoStart),
        lte(recordingChunks.sequenceNo, sequenceNoEnd),
      ),
    )
    .orderBy(asc(recordingChunks.sequenceNo));

  const expectedChunkCount = sequenceNoEnd - sequenceNoStart + 1;
  if (chunkRows.length !== expectedChunkCount) {
    throw new Error("Cannot transcribe batch with missing chunk rows");
  }

  const dirPath = await mkdtemp(join(tmpdir(), "chunking-pipeline-batch-"));
  const bucketName = getRecordingBucketName();
  const minioClient = getMinioClient();

  const files: Array<{ sequenceNo: number; filePath: string }> = [];

  for (const chunk of chunkRows) {
    if (chunk.ackState !== "acked" && chunk.ackState !== "repaired") {
      throw new Error("Cannot transcribe batch with non-acked chunks");
    }

    const objectStream = await minioClient.getObject(
      bucketName,
      chunk.bucketKey,
    );
    const filePath = join(dirPath, `${chunk.sequenceNo}.webm`);
    await saveReadableStreamToFile(objectStream, filePath);
    files.push({ sequenceNo: chunk.sequenceNo, filePath });
  }

  return {
    dirPath,
    files,
  };
}

async function transcribeBatchRange(
  sessionId: string,
  sequenceNoStart: number,
  sequenceNoEnd: number,
): Promise<TranscribedSegment[]> {
  const { dirPath, files } = await downloadBatchChunkFiles(
    sessionId,
    sequenceNoStart,
    sequenceNoEnd,
  );

  try {
    const mergedWebmPath = join(dirPath, "merged.webm");
    const mergedWavPath = join(dirPath, "merged.wav");
    // Expected time window for this batch; used to reject under-covered outputs.
    const expectedDurationSec =
      (sequenceNoEnd - sequenceNoStart + 1) * CHUNK_DURATION_SECONDS;

    let mergedSegments: TranscribedSegment[] = [];
    let mergedError: unknown = null;

    try {
      // Primary path: concatenate all chunks then transcode once for best continuity.
      await concatFilesBinary(
        files.map((file) => file.filePath),
        mergedWebmPath,
      );
      await runFfmpegTranscodeToWav(mergedWebmPath, mergedWavPath);

      const mergedOffsetSec = sequenceNoStart * CHUNK_DURATION_SECONDS;
      mergedSegments = await transcribeSingleFile(
        mergedWavPath,
        mergedOffsetSec,
        "batch.wav",
        "audio/wav",
      );
    } catch (error) {
      mergedError = error;
      // Fallback below transcribes individual chunk files.
    }

    const fallbackSegments: TranscribedSegment[] = [];
    let firstFallbackError: string | null = null;

    for (const file of files) {
      const chunkOffsetSec = file.sequenceNo * CHUNK_DURATION_SECONDS;
      const fallbackWavPath = join(dirPath, `chunk-${file.sequenceNo}.wav`);

      try {
        // Fallback path: transcode and transcribe chunk-by-chunk to salvage partial failures.
        await runFfmpegTranscodeToWav(file.filePath, fallbackWavPath);
        const segments = await transcribeSingleFile(
          fallbackWavPath,
          chunkOffsetSec,
          `chunk-${file.sequenceNo}.wav`,
          "audio/wav",
        );
        fallbackSegments.push(...segments);
      } catch (error) {
        if (!firstFallbackError) {
          firstFallbackError = getErrorMessage(error);
        }
      }
    }

    const mergedCoverageSec = getSegmentsCoverageSeconds(mergedSegments);
    const fallbackCoverageSec = getSegmentsCoverageSeconds(fallbackSegments);

    const mergedCoverageRatio =
      expectedDurationSec > 0 ? mergedCoverageSec / expectedDurationSec : 0;
    const fallbackCoverageRatio =
      expectedDurationSec > 0 ? fallbackCoverageSec / expectedDurationSec : 0;

    const mergedAcceptable =
      mergedSegments.length > 0 &&
      mergedCoverageRatio >= MIN_ACCEPTABLE_COVERAGE_RATIO;
    const fallbackAcceptable =
      fallbackSegments.length > 0 &&
      fallbackCoverageRatio >= MIN_ACCEPTABLE_COVERAGE_RATIO;

    if (mergedAcceptable || fallbackAcceptable) {
      // Choose the better-covered timeline rather than whichever finished first.
      if (fallbackCoverageRatio > mergedCoverageRatio) {
        return fallbackSegments;
      }

      return mergedSegments;
    }

    if (firstFallbackError) {
      const fallbackErrorText = firstFallbackError.toLowerCase();
      const mergedErrorText = mergedError
        ? getErrorMessage(mergedError).toLowerCase()
        : "";

      const ffmpegMissing =
        mergedErrorText.includes("ffmpeg executable not found") ||
        (mergedErrorText.includes("enoent") &&
          mergedErrorText.includes("ffmpeg"));

      const invalidOpenAiFormat = fallbackErrorText.includes(
        "invalid file format",
      );

      if (ffmpegMissing && invalidOpenAiFormat) {
        throw new Error(
          "FFmpeg is required to merge recorder chunks into a Whisper-compatible file. Install FFmpeg (or set FFMPEG_PATH) and retry transcription.",
        );
      }

      if (mergedSegments.length > 0 || fallbackSegments.length > 0) {
        throw new Error(
          "Transcription coverage is too short for this recording window. Audio merge/decode likely incomplete.",
        );
      }

      throw new Error(firstFallbackError);
    }

    if (mergedError) {
      throw new Error(getErrorMessage(mergedError));
    }

    return [];
  } finally {
    await rm(dirPath, { recursive: true, force: true });
  }
}

async function persistBatchSegments(
  sessionId: string,
  sequenceNoStart: number,
  sequenceNoEnd: number,
  segments: TranscribedSegment[],
) {
  const db = getDb();

  await db
    .delete(transcriptionSegments)
    .where(
      and(
        eq(transcriptionSegments.sessionId, sessionId),
        gte(transcriptionSegments.sequenceNoStart, sequenceNoStart),
        lte(transcriptionSegments.sequenceNoEnd, sequenceNoEnd),
      ),
    );

  if (segments.length === 0) {
    return;
  }

  await db.insert(transcriptionSegments).values(
    segments.map((segment, index) => {
      const sequenceNo = Math.max(
        sequenceNoStart,
        Math.min(sequenceNoEnd, toSequenceNoFromSecond(segment.startSec)),
      );

      return {
        id: randomUUID(),
        sessionId,
        sequenceNoStart: sequenceNo,
        sequenceNoEnd: sequenceNo,
        speakerLabel: buildSpeakerLabel(index),
        text: segment.text,
        startSec: segment.startSec,
        endSec: Math.max(segment.endSec, segment.startSec + 0.05),
      };
    }),
  );

  await db
    .insert(sessionSpeakers)
    .values([
      {
        id: randomUUID(),
        sessionId,
        speakerLabel: "User1",
        clusterKey: "cluster_user_1",
        confidence: 0.4,
      },
      {
        id: randomUUID(),
        sessionId,
        speakerLabel: "User2",
        clusterKey: "cluster_user_2",
        confidence: 0.4,
      },
    ])
    .onConflictDoNothing();
}

async function processSingleBatch(
  sessionId: string,
  batchIndex: number,
  expectedLastSequenceNo: number,
) {
  const db = getDb();

  const sequenceNoStart = batchIndex * CHUNKS_PER_BATCH;
  const sequenceNoEnd = Math.min(
    expectedLastSequenceNo,
    (batchIndex + 1) * CHUNKS_PER_BATCH - 1,
  );

  const [batchRecord] = await db
    .insert(transcriptionBatches)
    .values({
      id: randomUUID(),
      sessionId,
      batchIndex,
      sequenceNoStart,
      sequenceNoEnd,
      audioOffsetSec: sequenceNoStart * CHUNK_DURATION_SECONDS,
      status: "queued",
      attemptCount: 0,
      errorMessage: null,
    })
    .onConflictDoNothing()
    .returning();

  const batchId =
    batchRecord?.id ??
    (
      await db
        .select({ id: transcriptionBatches.id })
        .from(transcriptionBatches)
        .where(
          and(
            eq(transcriptionBatches.sessionId, sessionId),
            eq(transcriptionBatches.batchIndex, batchIndex),
          ),
        )
        .limit(1)
    )[0]?.id;

  if (!batchId) {
    throw new Error("Failed to initialize transcription batch record");
  }

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
    // Retry individual batch failures without restarting the whole session.
    await db
      .update(transcriptionBatches)
      .set({ status: "running", attemptCount: attempt, errorMessage: null })
      .where(eq(transcriptionBatches.id, batchId));

    try {
      const segments = await transcribeBatchRange(
        sessionId,
        sequenceNoStart,
        sequenceNoEnd,
      );

      await persistBatchSegments(
        sessionId,
        sequenceNoStart,
        sequenceNoEnd,
        segments,
      );

      await db
        .update(transcriptionBatches)
        .set({ status: "completed", errorMessage: null })
        .where(eq(transcriptionBatches.id, batchId));

      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
      await db
        .update(transcriptionBatches)
        .set({ status: "failed", errorMessage: lastError })
        .where(eq(transcriptionBatches.id, batchId));
    }
  }

  throw new Error(lastError ?? "Batch transcription failed");
}

// Runs the post-finalize transcription pipeline in background workers.
async function runTranscriptionWorker(sessionId: string) {
  const db = getDb();

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  if (
    session.expectedLastSequenceNo === null ||
    session.expectedLastSequenceNo === undefined
  ) {
    throw new Error("Session missing expected_last_sequence_no");
  }

  const [job] = await db
    .select()
    .from(transcriptionJobs)
    .where(eq(transcriptionJobs.sessionId, sessionId))
    .limit(1);

  const nextAttempt = (job?.attemptCount ?? 0) + 1;

  await db
    .update(recordingSessions)
    .set({ status: "transcribing" })
    .where(eq(recordingSessions.id, sessionId));

  await db
    .update(transcriptionJobs)
    .set({
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      attemptCount: nextAttempt,
      errorMessage: null,
    })
    .where(eq(transcriptionJobs.sessionId, sessionId));

  const totalChunkCount = session.expectedLastSequenceNo + 1;
  const batchCount = Math.ceil(totalChunkCount / CHUNKS_PER_BATCH);
  const queue = Array.from({ length: batchCount }, (_, index) => index);
  // Bound concurrency so long sessions do not overwhelm network/API quotas.
  const workerCount = Math.min(TRANSCRIPTION_CONCURRENCY, queue.length);

  try {
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const nextBatch = queue.shift();
        if (nextBatch === undefined) {
          return;
        }

        await processSingleBatch(
          sessionId,
          nextBatch,
          session.expectedLastSequenceNo!,
        );
      }
    });

    await Promise.all(workers);

    await db
      .update(transcriptionJobs)
      .set({ status: "completed", completedAt: new Date(), errorMessage: null })
      .where(eq(transcriptionJobs.sessionId, sessionId));

    await db
      .update(recordingSessions)
      .set({ status: "completed" })
      .where(eq(recordingSessions.id, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await db
      .update(transcriptionJobs)
      .set({ status: "failed", errorMessage: message })
      .where(eq(transcriptionJobs.sessionId, sessionId));

    await db
      .update(recordingSessions)
      .set({ status: "failed" })
      .where(eq(recordingSessions.id, sessionId));
  }
}

// Schedules transcription worker without blocking request handling.
function enqueueTranscriptionWorker(sessionId: string) {
  queueMicrotask(() => {
    void runTranscriptionWorker(sessionId).catch(async (error) => {
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

// Ensures a session has a queued/running transcription job and starts worker.
export async function startTranscriptionForSession(sessionId: string) {
  const db = getDb();

  const [session] = await db
    .select()
    .from(recordingSessions)
    .where(eq(recordingSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error("Session not found");
  }

  const [existingJob] = await db
    .select()
    .from(transcriptionJobs)
    .where(eq(transcriptionJobs.sessionId, sessionId))
    .limit(1);

  if (!existingJob) {
    await db.insert(transcriptionJobs).values({
      id: randomUUID(),
      sessionId,
      status: "queued",
      provider: "openai_whisper",
      model: getServerEnv().OPENAI_WHISPER_MODEL,
      errorMessage: null,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
    });
  }

  const [job] = await db
    .select()
    .from(transcriptionJobs)
    .where(eq(transcriptionJobs.sessionId, sessionId))
    .limit(1);

  if (!job) {
    throw new Error("Failed to initialize transcription job");
  }

  if (job.status === "running") {
    return {
      sessionId,
      status: "already_running" as const,
    };
  }

  if (job.status === "completed") {
    return {
      sessionId,
      status: "already_completed" as const,
    };
  }

  enqueueTranscriptionWorker(sessionId);

  return {
    sessionId,
    status: "queued" as const,
  };
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

  await db
    .update(recordingSessions)
    .set({ lastHeartbeatAt: new Date() })
    .where(eq(recordingSessions.id, sessionId));

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
      id: randomUUID(),
      sessionId,
      status: "queued",
      provider: "openai_whisper",
      model: getServerEnv().OPENAI_WHISPER_MODEL,
      errorMessage: null,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
    })
    .onConflictDoNothing();

  await startTranscriptionForSession(sessionId);

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

  const batches = await db
    .select({
      status: transcriptionBatches.status,
      id: transcriptionBatches.id,
    })
    .from(transcriptionBatches)
    .where(eq(transcriptionBatches.sessionId, sessionId));

  const completedBatchCount = batches.filter(
    (batch) => batch.status === "completed",
  ).length;

  return {
    sessionId,
    status: job.status,
    provider: job.provider,
    model: job.model,
    segmentCount: segments.length,
    batchCount: batches.length,
    completedBatchCount,
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

  const fullText = segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

  return {
    ...status,
    speakers,
    fullText,
    segments,
  };
}
