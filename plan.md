# Reliable Recording + Transcription Plan (No Fancy UI)

## 1. Goal and Constraints

Build a plain Next.js recording page that:

1. Captures microphone audio.
2. Bifurcates multi-speaker meeting audio into speaker labels (`User1`, `User2`, ...) in transcription output.
3. Stores and uploads chunks with zero silent loss.
4. Runs transcription only after user presses Stop (not live).
5. Supports 1-hour recording tests with reliability as the top priority.

Fixed stack:

- Frontend: Next.js + MediaRecorder (`audio/webm;codecs=opus`) + OPFS.
- Backend: Hono on Bun.
- Storage: MinIO (S3-compatible bucket).
- Database: PostgreSQL + Drizzle.
- Transcription: OpenAI Whisper API (`whisper-large-v3`).

## 2. End-to-End Flow

1. User starts microphone recording for meeting audio (single or multi-speaker).
2. Frontend requests microphone permission.
3. Recording starts and emits chunks every N seconds (recommended 5s).
4. Each chunk is written to OPFS first, then queued for upload.
5. Backend writes chunk to MinIO and durable ack to Postgres.
6. On Stop, frontend finalizes session and waits until all chunks are acked.
7. Finalize flow automatically triggers server-side reconciliation (not manual-only).
8. If missing objects are detected, client repairs from OPFS and finalize is retried.
9. Backend starts post-stop transcription + speaker diarization only after reconciliation is clean.
10. Transcript is stitched by sequence/time and annotated with speaker labels (`User1`, `User2`, ...).
11. Transcript status is polled until complete.
12. OPFS cleanup only after final durable conditions are met.

## 3. Reliability Contract (Hard Invariants)

1. No upload attempt occurs before OPFS persistence succeeds.
2. Each chunk has deterministic identity and checksum.
3. Ack is returned only after MinIO write success and DB commit.
4. Upload API is idempotent for duplicates/retries.
5. Client never deletes local chunk until ack is confirmed.
6. Session finalize requires contiguous chunk sequence with no gaps.
7. Transcription starts only after session finalize is marked complete.
8. If DB says acked but object missing in MinIO, system marks `repair_needed` and re-uploads from OPFS.
9. If OPFS write fails (for example quota exceeded), recording is blocked immediately and upload is not allowed to proceed without local durability.
10. Speaker labels are consistent within a session (same voice maps to the same `UserN` label after stitching).

## 4. Data Model (Drizzle + PostgreSQL)

### 4.1 Speaker diarization entities

`session_speakers`

- `id` (uuid)
- `session_id` (fk)
- `speaker_label` (text, format `User[1-9][0-9]*`)
- `cluster_key` (text, internal diarization cluster id)
- `confidence` (float)
- unique (`session_id`, `speaker_label`)

### 4.2 Sessions

`recording_sessions`

- `id` (uuid)
- `status` (`created|recording|stopping|finalized|transcribing|completed|failed`)
- `started_at`, `stopped_at`
- `expected_last_sequence_no` (set on stop)
- `duration_ms`

### 4.3 Chunks

`recording_chunks`

- `chunk_id` (pk, `${session_id}:${sequence_no}:${sha256}`)
- `session_id` (fk)
- `sequence_no` (int)
- `sha256` (text)
- `size_bytes` (int)
- `mime_type` (text, `audio/webm;codecs=opus`)
- `bucket_key` (text)
- `bucket_etag` (text)
- `ack_state` (`pending|acked|repair_needed|repaired`)
- `acked_at`
- unique (`session_id`, `sequence_no`)

### 4.4 Transcription

`transcription_jobs`

- `id` (uuid)
- `session_id` (fk, unique)
- `status` (`queued|running|completed|failed`)
- `provider` (`openai_whisper`)
- `model` (`whisper-large-v3`)
- `error_message`
- `started_at`, `completed_at`

`transcription_batches`

- `id` (uuid)
- `session_id` (fk)
- `batch_index` (int)
- `sequence_no_start`, `sequence_no_end`
- `audio_offset_sec` (float)
- `status` (`queued|running|completed|failed`)
- `attempt_count` (int)
- unique (`session_id`, `batch_index`)

`transcription_segments`

- `id` (uuid)
- `session_id` (fk)
- `sequence_no_start`, `sequence_no_end`
- `speaker_label` (text, `User1|User2|...`)
- `text`
- `start_sec`, `end_sec`

## 5. Frontend Plan (Plain Next.js)

### 5.1 Minimal page controls

- `Start Recording` button.
- `Stop Recording` button.
- Text status: queued/uploading/acked/pending repairs/transcription status/speaker count detected.

No fancy styling; functional layout only.

### 5.2 Microphone capture settings

- `navigator.mediaDevices.getUserMedia({ audio: true })`.
- `MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" })`.
- `mediaRecorder.start(5000)` for 5s chunks.

Why 5s chunks:

- lower retry cost per failure
- better recovery for long recordings
- manageable OPFS writes over 1 hour

### 5.3 OPFS-first durability

Per chunk:

1. Compute `sha256` with Web Crypto.
2. Persist blob in OPFS (`/sessions/{session_id}/{sequence_no}.webm`).
3. Persist manifest row (`state=persisted`, metadata).
4. Push to upload queue.

Manifest should include local state machine and retry counters.

Hard failure behavior:

- If OPFS write throws quota/storage error, stop recording, mark session `failed`, show blocking error, and do not upload that chunk over network.

### 5.4 Client state machine

`new -> persisted -> queued -> uploading -> acked -> gc_ready -> deleted`

Error states:

- `upload_failed_retryable`
- `upload_failed_fatal`
- `repair_needed`

On app reload/crash, replay all non-terminal states.

### 5.5 Stop and finalize behavior (non-live transcription trigger)

When user presses Stop:

1. Stop recorder and flush final chunk.
2. Wait for in-flight uploads to settle.
3. Call finalize endpoint with `expected_last_sequence_no`.
4. Server verifies contiguous acked set.
5. Server automatically runs reconciliation for the finalized range.
6. If reconciliation returns missing chunks, client performs repair uploads from OPFS and retries finalize.
7. Only after clean reconciliation does server enqueue transcription job.

This guarantees transcription uses complete audio.

### 5.6 1-hour recording handling

- Keep bounded upload concurrency (4-8 workers).
- Monitor OPFS usage and expose warning threshold.
- Send heartbeat every 15-30 seconds while recording.
- Use `beforeunload` marker to improve crash diagnostics (not for blocking user).

## 6. Backend API Plan (Hono + Bun)

### 6.1 Session endpoints

- `POST /api/recordings/sessions` -> create recording session.
- `PATCH /api/recordings/sessions/:sessionId/heartbeat` -> keep session liveness during long recordings.

### 6.2 Idempotent chunk upload

`PUT /api/recordings/chunks/:chunkId`

Request includes `session_id`, `sequence_no`, `sha256`, `size_bytes`, binary body.

Server steps:

1. Validate metadata and deterministic key.
2. Verify payload hash while streaming.
3. Upload to MinIO key `recordings/{session_id}/{sequence_no}-{sha256}.webm`.
4. `HEAD` object and capture `etag`.
5. Transactional upsert ack row in Postgres.
6. Return durable ack payload.

Duplicate request behavior: return existing ack (200), no corruption.

### 6.3 Session finalize endpoint

`POST /api/recordings/sessions/:sessionId/finalize`

Input: `expected_last_sequence_no`.

Checks:

1. DB has all sequence numbers from `0..expected_last_sequence_no`.
2. All those chunks are `acked` or `repaired`.
3. Session duration is captured.
4. Reconciliation is executed automatically for the same sequence range.

Then:

- if reconciliation is clean: mark session `finalized` and enqueue transcription job
- if reconciliation finds missing objects: return `repair_required` with chunk IDs and keep session in `stopping` until repaired

### 6.4 Transcription endpoints

- `POST /api/transcriptions/:sessionId/start` (internal/system use)
- `GET /api/transcriptions/:sessionId/status`
- `GET /api/transcriptions/:sessionId/result` (returns diarized transcript with `UserN` speaker labels)

### 6.5 Reconciliation endpoints

- `POST /api/recordings/reconcile`
- `POST /api/recordings/repair/:chunkId`

## 7. Transcription + Speaker Bifurcation Strategy (OpenAI Whisper Large v3, Post-Stop Only)

### 7.1 Why post-stop only

- avoids partial transcript drift
- simpler and more reliable than live stream stitching
- easier to enforce "complete audio only" invariant

### 7.2 Primary strategy: 25MB-safe batch transcription

Primary (not fallback):

1. Group every 60 chunks (5 minutes at 5s/chunk) into one transcription batch.
2. Each batch is about 2-3MB at 64kbps, safely below the 25MB Whisper request limit.
3. Transcribe batches in parallel with bounded worker concurrency (for example 4-6 workers).
4. Store each batch transcript with `batch_index` and `audio_offset_sec`.
5. Stitch final transcript by `sequence_no` order with timestamp offsets (`batch_index` as tie-breaker).

This keeps throughput high while respecting API size limits.

### 7.3 Speaker bifurcation pipeline (`User1`, `User2`, ...)

1. Run Whisper on each batch for ASR text + timestamps.
2. Run diarization on the same batch windows to get speaker time spans.
3. Align ASR tokens/segments to diarization spans by timestamp intersection.
4. Cluster speakers across all batches to keep stable global labels per session.
5. Emit normalized speaker labels in transcript (`User1`, `User2`, ...).

### 7.4 Chunk-boundary context and dedup

To reduce boundary word cuts and improve accuracy:

1. When building transcription inputs, add 2-second overlap context between adjacent chunk boundaries.
2. Keep overlap metadata (source sequence and time window).
3. During stitching, deduplicate overlap text using timestamp alignment plus normalized-text similarity.

This overlap-and-dedup step is mandatory for accurate long-form transcripts.

### 7.5 Accuracy safeguards

- strict chunk ordering before transcription
- reject finalize if missing sequence numbers
- retry failed Whisper calls with capped backoff
- persist intermediate segment transcripts to avoid full restart
- set language hint when known
- `temperature=0` for deterministic output
- perform cross-batch speaker-cluster merge before final `UserN` assignment

## 8. Failure Scenarios and Recovery

1. Client crashes during recording:
   - OPFS + manifest restore pending chunks on reload.

2. Upload succeeded but response lost:
   - retry same `chunk_id`; server returns existing ack.

3. MinIO success but DB failure:
   - retry path upserts ack without duplicate object problems.

4. Ack exists but object removed from MinIO:
   - reconciliation marks `repair_needed`; client re-uploads from OPFS.

5. Stop pressed with pending chunks:
   - finalize blocks until contiguous ack coverage exists.

6. Whisper failure/timeouts:
   - job remains resumable with status + retry metadata.

7. OPFS quota exceeded:
   - client stops recording immediately, surfaces blocking error, and prevents non-durable upload path.

## 9. Performance and Endurance Targets

1-hour test baseline (single session):

- 5s chunks -> about 720 chunks/session.
- 60 chunks/batch -> about 12 transcription batches/session.
- zero missing chunks after reconciliation.
- finalize completes only when all expected chunks are durable.
- transcription eventually completes with persisted result.

Load target remains 300k upload requests with same invariants.

## 10. Observability

Metrics:

- `chunks_created_total`
- `chunks_persisted_opfs_total`
- `chunk_upload_attempt_total{result}`
- `chunk_acked_total`
- `reconciliation_repair_needed_total`
- `session_finalize_attempt_total{result}`
- `transcription_job_total{status}`
- `transcription_latency_ms`

Structured logs (always include):

- `session_id`, `chunk_id`, `sequence_no`, `attempt_no`, `transcription_job_id`, `speaker_label`, `speaker_count`

## 11. Test Plan

### 11.1 Functional tests

- microphone permission and recording start/stop
- speaker bifurcation in transcript (`User1`, `User2`, ...)
- post-stop transcription trigger only after finalize

### 11.2 Reliability tests

- crash/reload mid-recording
- offline/online transitions
- duplicate chunk uploads
- MinIO object deletion then reconcile+repair

### 11.3 1-hour endurance test

- full 1-hour recording per session
- verify contiguous chunk sequence
- verify DB ack count equals expected chunk count
- verify transcription completion and non-empty output

### 11.4 Load tests

- k6/autocannon for high RPS upload endpoint
- periodic reconciliation during load
- final SQL + MinIO verification queries

## 12. Execution Roadmap

1. Phase 1: Drizzle schema for sessions, chunks, transcription jobs, and session speakers.
2. Phase 2: Hono upload/finalize/reconcile APIs with strict idempotency.
3. Phase 3: Next.js page with mic capture + OPFS queue + stop/finalize flow.
4. Phase 4: Whisper-large-v3 batch transcription worker (60-chunk batches, parallel, overlap dedup) + status/result endpoints.
5. Phase 5: Reconciliation hardening + fault injection tests.
6. Phase 6: 1-hour endurance + 300k load validation report.

## 13. Winning Criteria

1. No single chunk is missed for 1-hour recordings.
2. No silent data loss under retry/crash/network failures.
3. Transcription starts only after stop + successful finalize.
4. Transcript is diarized into consistent speaker labels (`User1`, `User2`, ...) and stored durably.
5. Evidence from logs/metrics/queries proves accuracy and reliability.
