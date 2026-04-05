import { randomUUID } from "crypto";

export type RecordingSessionStatus =
  | "created"
  | "recording"
  | "stopping"
  | "finalized"
  | "transcribing"
  | "completed"
  | "failed";

export type ChunkAckState = "pending" | "acked" | "repair_needed" | "repaired";

export type ChunkRecord = {
  chunkId: string;
  sessionId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  bucketKey: string;
  bucketEtag: string;
  ackState: ChunkAckState;
  ackedAt: string;
};

type SessionRecord = {
  id: string;
  status: RecordingSessionStatus;
  startedAt: string;
  stoppedAt?: string;
  expectedLastSequenceNo?: number;
  durationMs?: number;
};

type TranscriptionJobRecord = {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed";
  provider: "openai_whisper";
  model: "whisper-large-v3";
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type TranscriptionSegment = {
  id: string;
  sessionId: string;
  sequenceNoStart: number;
  sequenceNoEnd: number;
  speakerLabel: string;
  text: string;
  startSec: number;
  endSec: number;
};

const sessions = new Map<string, SessionRecord>();
const chunksBySession = new Map<string, Map<number, ChunkRecord>>();
const transcriptionJobs = new Map<string, TranscriptionJobRecord>();
const transcriptionSegmentsBySession = new Map<
  string,
  TranscriptionSegment[]
>();

function getSessionOrThrow(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  return session;
}

function getOrCreateChunkMap(sessionId: string) {
  if (!chunksBySession.has(sessionId)) {
    chunksBySession.set(sessionId, new Map<number, ChunkRecord>());
  }
  return chunksBySession.get(sessionId)!;
}

function buildSpeakerLabel(sequenceNo: number) {
  return sequenceNo % 2 === 0 ? "User1" : "User2";
}

function scheduleTranscription(sessionId: string) {
  const session = getSessionOrThrow(sessionId);
  const job = transcriptionJobs.get(sessionId);
  if (!job || job.status !== "queued") {
    return;
  }

  session.status = "transcribing";
  job.status = "running";
  job.startedAt = new Date().toISOString();

  setTimeout(() => {
    const chunkMap = getOrCreateChunkMap(sessionId);
    const orderedChunks = [...chunkMap.values()].sort(
      (a, b) => a.sequenceNo - b.sequenceNo,
    );

    const segments: TranscriptionSegment[] = orderedChunks.map((chunk) => ({
      id: randomUUID(),
      sessionId,
      sequenceNoStart: chunk.sequenceNo,
      sequenceNoEnd: chunk.sequenceNo,
      speakerLabel: buildSpeakerLabel(chunk.sequenceNo),
      text: `Bootstrap transcript for chunk ${chunk.sequenceNo}`,
      startSec: chunk.sequenceNo * 5,
      endSec: chunk.sequenceNo * 5 + 5,
    }));

    transcriptionSegmentsBySession.set(sessionId, segments);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    session.status = "completed";
  }, 1500);
}

export function createSession() {
  const id = randomUUID();
  const session: SessionRecord = {
    id,
    status: "recording",
    startedAt: new Date().toISOString(),
  };

  sessions.set(id, session);
  return session;
}

export function heartbeatSession(sessionId: string) {
  const session = getSessionOrThrow(sessionId);
  return {
    sessionId,
    status: session.status,
    heartbeatAt: new Date().toISOString(),
  };
}

export function upsertChunk(input: {
  chunkId: string;
  sessionId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}) {
  getSessionOrThrow(input.sessionId);

  const expectedChunkId = `${input.sessionId}:${input.sequenceNo}:${input.sha256}`;
  if (input.chunkId !== expectedChunkId) {
    throw new Error("chunk_id does not match deterministic identity rule");
  }

  const chunkMap = getOrCreateChunkMap(input.sessionId);
  const existing = chunkMap.get(input.sequenceNo);
  if (existing) {
    return {
      duplicate: true,
      chunk: existing,
    };
  }

  const record: ChunkRecord = {
    chunkId: input.chunkId,
    sessionId: input.sessionId,
    sequenceNo: input.sequenceNo,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    bucketKey: `recordings/${input.sessionId}/${input.sequenceNo}-${input.sha256}.webm`,
    bucketEtag: input.sha256.slice(0, 16),
    ackState: "acked",
    ackedAt: new Date().toISOString(),
  };

  chunkMap.set(input.sequenceNo, record);
  return {
    duplicate: false,
    chunk: record,
  };
}

export function reconcileSession(
  sessionId: string,
  sequenceNoStart: number,
  sequenceNoEnd: number,
) {
  getSessionOrThrow(sessionId);
  const chunkMap = getOrCreateChunkMap(sessionId);

  const missingSequences: number[] = [];
  for (
    let sequenceNo = sequenceNoStart;
    sequenceNo <= sequenceNoEnd;
    sequenceNo += 1
  ) {
    const chunk = chunkMap.get(sequenceNo);
    if (
      !chunk ||
      (chunk.ackState !== "acked" && chunk.ackState !== "repaired")
    ) {
      missingSequences.push(sequenceNo);
    }
  }

  return {
    sessionId,
    sequenceNoStart,
    sequenceNoEnd,
    missingSequences,
    repairRequired: missingSequences.length > 0,
  };
}

export function repairChunk(chunkId: string) {
  for (const [, chunkMap] of chunksBySession) {
    for (const chunk of chunkMap.values()) {
      if (chunk.chunkId === chunkId) {
        chunk.ackState = "repaired";
        chunk.ackedAt = new Date().toISOString();
        return chunk;
      }
    }
  }

  throw new Error("Chunk not found");
}

export function finalizeSession(
  sessionId: string,
  expectedLastSequenceNo: number,
) {
  const session = getSessionOrThrow(sessionId);
  session.status = "stopping";

  const reconciliation = reconcileSession(sessionId, 0, expectedLastSequenceNo);
  if (reconciliation.repairRequired) {
    return {
      finalized: false,
      sessionId,
      status: "repair_required" as const,
      missingSequences: reconciliation.missingSequences,
    };
  }

  const stoppedAt = new Date().toISOString();
  const started = new Date(session.startedAt).valueOf();
  const stopped = new Date(stoppedAt).valueOf();

  session.status = "finalized";
  session.expectedLastSequenceNo = expectedLastSequenceNo;
  session.stoppedAt = stoppedAt;
  session.durationMs = stopped - started;

  if (!transcriptionJobs.has(sessionId)) {
    transcriptionJobs.set(sessionId, {
      id: randomUUID(),
      sessionId,
      status: "queued",
      provider: "openai_whisper",
      model: "whisper-large-v3",
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });
  }

  scheduleTranscription(sessionId);

  return {
    finalized: true,
    sessionId,
    status: "finalized" as const,
    expectedLastSequenceNo,
  };
}

export function getTranscriptionStatus(sessionId: string) {
  getSessionOrThrow(sessionId);

  const job = transcriptionJobs.get(sessionId);
  if (!job) {
    return {
      sessionId,
      status: "not_found" as const,
    };
  }

  const segments = transcriptionSegmentsBySession.get(sessionId) ?? [];

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

export function getTranscriptionResult(sessionId: string) {
  const status = getTranscriptionStatus(sessionId);
  const segments = transcriptionSegmentsBySession.get(sessionId) ?? [];

  const speakers = [
    ...new Set(segments.map((segment) => segment.speakerLabel)),
  ];

  return {
    ...status,
    speakers,
    segments,
  };
}
