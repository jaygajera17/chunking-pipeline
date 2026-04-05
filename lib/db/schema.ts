import {
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const recordingSessionStatusEnum = pgEnum("recording_session_status", [
  "created",
  "recording",
  "stopping",
  "finalized",
  "transcribing",
  "completed",
  "failed",
]);

export const chunkAckStateEnum = pgEnum("chunk_ack_state", [
  "pending",
  "acked",
  "repair_needed",
  "repaired",
]);

export const transcriptionJobStatusEnum = pgEnum("transcription_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const transcriptionBatchStatusEnum = pgEnum(
  "transcription_batch_status",
  ["queued", "running", "completed", "failed"],
);

export const recordingSessions = pgTable("recording_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: recordingSessionStatusEnum("status").notNull().default("created"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  expectedLastSequenceNo: integer("expected_last_sequence_no"),
  durationMs: integer("duration_ms"),
});

export const recordingChunks = pgTable(
  "recording_chunks",
  {
    chunkId: text("chunk_id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => recordingSessions.id, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type").notNull(),
    bucketKey: text("bucket_key").notNull(),
    bucketEtag: text("bucket_etag"),
    ackState: chunkAckStateEnum("ack_state").notNull().default("pending"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => [
    unique("recording_chunks_session_id_sequence_no_unique").on(
      table.sessionId,
      table.sequenceNo,
    ),
  ],
);

export const transcriptionJobs = pgTable("transcription_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => recordingSessions.id, { onDelete: "cascade" })
    .unique(),
  status: transcriptionJobStatusEnum("status").notNull().default("queued"),
  provider: text("provider").notNull().default("openai_whisper"),
  model: text("model").notNull().default("whisper-large-v3"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const transcriptionBatches = pgTable(
  "transcription_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => recordingSessions.id, { onDelete: "cascade" }),
    batchIndex: integer("batch_index").notNull(),
    sequenceNoStart: integer("sequence_no_start").notNull(),
    sequenceNoEnd: integer("sequence_no_end").notNull(),
    audioOffsetSec: real("audio_offset_sec").notNull(),
    status: transcriptionBatchStatusEnum("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [
    unique("transcription_batches_session_id_batch_index_unique").on(
      table.sessionId,
      table.batchIndex,
    ),
  ],
);

export const transcriptionSegments = pgTable("transcription_segments", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => recordingSessions.id, { onDelete: "cascade" }),
  sequenceNoStart: integer("sequence_no_start").notNull(),
  sequenceNoEnd: integer("sequence_no_end").notNull(),
  speakerLabel: text("speaker_label").notNull(),
  text: text("text").notNull(),
  startSec: real("start_sec").notNull(),
  endSec: real("end_sec").notNull(),
});

export const sessionSpeakers = pgTable(
  "session_speakers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => recordingSessions.id, { onDelete: "cascade" }),
    speakerLabel: text("speaker_label").notNull(),
    clusterKey: text("cluster_key").notNull(),
    confidence: real("confidence").notNull().default(0),
  },
  (table) => [
    unique("session_speakers_session_id_speaker_label_unique").on(
      table.sessionId,
      table.speakerLabel,
    ),
  ],
);
