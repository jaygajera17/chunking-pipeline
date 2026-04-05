# Reliable Recording + Transcription Pipeline

This project is a reliability-first voice recording pipeline for long-form sessions.

The core goal is simple: no silent loss between browser capture and final transcript.

## Problem It Solved

Long recordings often fail in subtle ways:

- chunk upload succeeds but response is lost
- chunk is marked acked in DB but missing in object storage
- tab refresh/crash during recording breaks continuity
- transcription starts before data is fully durable

Our approach prioritizes durability and recoverability over UI complexity.

## Approach Summary

1. Record audio in 5-second browser chunks.
2. Persist each chunk to OPFS before network upload.
3. Upload chunk to MinIO with deterministic chunk identity.
4. Ack in Postgres only after MinIO write verification.
5. On Stop, run finalize with reconciliation.
6. If reconciliation finds gaps, repair from OPFS and retry finalize.
7. Start background transcription only after finalize is clean.

This creates an end-to-end durability chain from browser disk to transcript result.

## Architecture

Single Next.js app with integrated API routes:

- Frontend: Next.js App Router + MediaRecorder + OPFS
- API layer: Hono handlers mounted under Next.js route handlers
- DB: PostgreSQL + Drizzle ORM
- Object storage: MinIO (S3-compatible)
- Transcription: OpenAI Audio API

## Reliability Design (Key Decisions)

1. OPFS-first writes: upload is never attempted before local persistence.
2. Deterministic chunk identity: chunk_id = session_id:sequence_no:sha256.
3. Idempotent upload endpoint: duplicate uploads return existing ack safely.
4. Reconciliation gate before finalize: contiguous sequence and bucket object checks.
5. Repair path: re-upload missing bucket objects from OPFS.
6. Post-stop transcription: transcript generation begins only after durable finalize.
7. Session recovery: manifest-driven resume for interrupted browser sessions.

## UX Strategy

The UI is transcript-first for normal users, with diagnostics still available:

- main panel focuses on recording state and transcript output
- technical metadata (chunk states, retries, OPFS paths) moved to diagnostics panel
- explicit processing states on stop: stopping -> flushing -> finalizing -> transcribing

## Data Model (High Level)

- recording_sessions: lifecycle and timing
- recording_chunks: durable chunk ledger + ack state
- transcription_jobs: job-level status
- transcription_batches: per-batch progress/retries
- transcription_segments: final text segments
- session_speakers: normalized speaker labels

## Quick Start (Local)

### 1) Install

```bash
npm install
```

### 2) Configure env

```bash
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`.

### 3) Start Postgres

```bash
docker run --name chunking-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=recording_db \
  -p 5432:5432 \
  -d postgres:16-alpine
```

### 4) Start MinIO

```bash
docker run --name chunking-minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  -v chunking-minio-data:/data \
  -d minio/minio server /data --console-address ":9001"
```

MinIO console: http://localhost:9001

### 5) Apply schema

```bash
npm run db:push
```

### 6) Install FFmpeg (required for best transcription coverage)

Windows:

```bash
winget install Gyan.FFmpeg
```

Optional: set explicit path if needed:

```bash
FFMPEG_PATH=C:\\path\\to\\ffmpeg.exe
```

### 7) Run app

```bash
npm run dev
```

Open: http://localhost:3000



## API Surface

- `POST /api/recordings/sessions`
- `PATCH /api/recordings/sessions/:sessionId/heartbeat`
- `PUT /api/recordings/chunks/:chunkId`
- `POST /api/recordings/sessions/:sessionId/finalize`
- `POST /api/recordings/reconcile`
- `POST /api/recordings/repair/:chunkId`
- `POST /api/transcriptions/:sessionId/start`
- `GET /api/transcriptions/:sessionId/status`
- `GET /api/transcriptions/:sessionId/result`

## Validation Commands

```bash
npm run typecheck
npm run lint
```

## Current Limitations / Trade-offs

1. Speaker labels currently use placeholder assignment (`User1`, `User2`) rather than true diarization clustering.
2. This repo is optimized for correctness and local reproducibility, not production multi-tenant scaling.
3. Load-test harness is not bundled yet; API and schema are ready for external k6/autocannon tests.
