"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const ACTIVE_SESSION_STORAGE_KEY = "recording-active-session-id";
const CHUNK_MIME_TYPE = "audio/webm;codecs=opus";
const CHUNK_INTERVAL_MS = 5000;
const MAX_UPLOAD_RETRIES = 5;
const MAX_FINALIZE_RETRIES = 3;
const TRANSCRIPTION_POLL_INTERVAL_MS = 3000;
const MAX_TRANSCRIPTION_POLLS = 400;
const STOP_UPLOAD_SETTLE_MS = 150;
const STOP_UPLOAD_SETTLE_MAX_CYCLES = 120;
const STOP_UPLOAD_IDLE_CYCLES = 2;
const FINAL_FLUSH_ROUNDS = 4;
const MANIFEST_WRITE_RETRIES = 5;
const MANIFEST_RETRY_BASE_MS = 40;

type ChunkState =
  | "persisted"
  | "queued"
  | "uploading"
  | "acked"
  | "repair_needed"
  | "failed";

type RecordingStatus =
  | "idle"
  | "recovering"
  | "preparing"
  | "recording"
  | "stopping"
  | "flushing"
  | "finalizing"
  | "repairing"
  | "transcribing"
  | "completed"
  | "stopped_no_data"
  | "failed";

type LocalChunk = {
  chunkId: string;
  sessionId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  opfsPath: string;
  state: ChunkState;
  retryCount: number;
  ackedAt?: string;
};

type FinalizeResponse = {
  status?: string;
  error?: string;
  missingSequences?: number[];
  missingChunkIds?: string[];
};

type TranscriptionStatusResponse = {
  status?: string;
  errorMessage?: string;
  segmentCount?: number;
  batchCount?: number;
  completedBatchCount?: number;
};

type TranscriptionResultResponse = {
  fullText?: string;
};

type SessionManifest = {
  sessionId: string;
  nextSequenceNo: number;
  status: RecordingStatus;
  chunks: LocalChunk[];
  updatedAt: string;
};

class UploadChunkError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpfsWriteLockError(error: unknown) {
  if (error instanceof DOMException) {
    return error.name === "NoModificationAllowedError";
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("NoModificationAllowedError");
}

async function digestSha256(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function writeChunkToOpfs(
  sessionId: string,
  sequenceNo: number,
  blob: Blob,
) {
  // OPFS write happens before upload to keep a local durable copy.
  const getDirectory = navigator.storage?.getDirectory;
  if (!getDirectory) {
    throw new Error("OPFS is not supported in this browser");
  }

  const root = await getDirectory.call(navigator.storage);
  const sessionsDir = await root.getDirectoryHandle("sessions", {
    create: true,
  });
  const sessionDir = await sessionsDir.getDirectoryHandle(sessionId, {
    create: true,
  });
  const chunkFile = await sessionDir.getFileHandle(`${sequenceNo}.webm`, {
    create: true,
  });

  const writable = await chunkFile.createWritable();
  await writable.write(blob);
  await writable.close();

  return `/sessions/${sessionId}/${sequenceNo}.webm`;
}

async function writeSessionManifest(manifest: SessionManifest) {
  for (let attempt = 0; attempt <= MANIFEST_WRITE_RETRIES; attempt += 1) {
    try {
      const getDirectory = navigator.storage?.getDirectory;
      if (!getDirectory) {
        return;
      }

      const root = await getDirectory.call(navigator.storage);
      const sessionsDir = await root.getDirectoryHandle("sessions", {
        create: true,
      });
      const sessionDir = await sessionsDir.getDirectoryHandle(
        manifest.sessionId,
        {
          create: true,
        },
      );

      const manifestHandle = await sessionDir.getFileHandle("manifest.json", {
        create: true,
      });

      const writable = await manifestHandle.createWritable();
      await writable.write(JSON.stringify(manifest));
      await writable.close();
      return;
    } catch (error) {
      const isRetryableLockError = isOpfsWriteLockError(error);
      if (!isRetryableLockError || attempt === MANIFEST_WRITE_RETRIES) {
        throw error;
      }

      await wait(MANIFEST_RETRY_BASE_MS * (attempt + 1));
    }
  }
}

async function readSessionManifest(sessionId: string) {
  const getDirectory = navigator.storage?.getDirectory;
  if (!getDirectory) {
    return null;
  }

  try {
    const root = await getDirectory.call(navigator.storage);
    const sessionsDir = await root.getDirectoryHandle("sessions", {
      create: false,
    });
    const sessionDir = await sessionsDir.getDirectoryHandle(sessionId, {
      create: false,
    });
    const manifestHandle = await sessionDir.getFileHandle("manifest.json", {
      create: false,
    });
    const manifestFile = await manifestHandle.getFile();
    const raw = await manifestFile.text();
    const parsed = JSON.parse(raw) as Partial<SessionManifest>;

    if (!parsed || !Array.isArray(parsed.chunks)) {
      return null;
    }

    return {
      sessionId,
      nextSequenceNo: Number(parsed.nextSequenceNo ?? 0),
      status: (parsed.status as RecordingStatus) ?? "idle",
      chunks: parsed.chunks as LocalChunk[],
      updatedAt: String(parsed.updatedAt ?? ""),
    } as SessionManifest;
  } catch {
    return null;
  }
}

async function removeSessionFromOpfs(sessionId: string) {
  const getDirectory = navigator.storage?.getDirectory;
  if (!getDirectory) {
    return;
  }

  try {
    const root = await getDirectory.call(navigator.storage);
    const sessionsDir = await root.getDirectoryHandle("sessions", {
      create: false,
    });
    await sessionsDir.removeEntry(sessionId, { recursive: true });
  } catch {
    // Ignore cleanup failures to avoid blocking completion path.
  }
}

async function readChunkFromOpfs(sessionId: string, sequenceNo: number) {
  const getDirectory = navigator.storage?.getDirectory;
  if (!getDirectory) {
    return null;
  }

  try {
    const root = await getDirectory.call(navigator.storage);
    const sessionsDir = await root.getDirectoryHandle("sessions", {
      create: false,
    });
    const sessionDir = await sessionsDir.getDirectoryHandle(sessionId, {
      create: false,
    });
    const chunkFile = await sessionDir.getFileHandle(`${sequenceNo}.webm`, {
      create: false,
    });
    return await chunkFile.getFile();
  } catch {
    return null;
  }
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [chunks, setChunks] = useState<LocalChunk[]>([]);
  const [transcriptionStatus, setTranscriptionStatus] = useState("not_started");
  const [transcript, setTranscript] = useState<string>("");
  const [opfsSupportText, setOpfsSupportText] = useState("checking");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingUploadsRef = useRef<Set<Promise<void>>>(new Set());
  const chunksRef = useRef<LocalChunk[]>([]);
  const sequenceRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<RecordingStatus>("idle");
  const manifestWriteChainRef = useRef<Promise<void>>(Promise.resolve());

  async function persistManifest(
    snapshotChunks: LocalChunk[] = chunksRef.current,
    snapshotStatus: RecordingStatus = statusRef.current,
    snapshotNextSequenceNo: number = sequenceRef.current,
  ) {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    const manifest: SessionManifest = {
      sessionId: activeSessionId,
      nextSequenceNo: snapshotNextSequenceNo,
      status: snapshotStatus,
      chunks: snapshotChunks,
      updatedAt: new Date().toISOString(),
    };

    const queuedWrite = manifestWriteChainRef.current
      .catch(() => {
        // Keep chain alive after a previous rejected write.
      })
      .then(async () => {
        await writeSessionManifest(manifest);
      })
      .catch((error) => {
        console.warn("Failed to persist OPFS manifest", error);
      });

    manifestWriteChainRef.current = queuedWrite;
    await queuedWrite;
  }

  function setStatusWithRef(nextStatus: RecordingStatus) {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    void persistManifest();
  }

  function setChunksWithRef(updater: (previous: LocalChunk[]) => LocalChunk[]) {
    setChunks((previous) => {
      const next = updater(previous);
      chunksRef.current = next;
      void persistManifest(next);
      return next;
    });
  }

  function updateChunkState(
    chunkId: string,
    state: ChunkState,
    patch?: Partial<LocalChunk>,
  ) {
    setChunksWithRef((previous) =>
      previous.map((chunk) =>
        chunk.chunkId === chunkId ? { ...chunk, state, ...patch } : chunk,
      ),
    );
  }

  useEffect(() => {
    const isSupported =
      typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
    setOpfsSupportText(isSupported ? "supported" : "not_supported");
  }, []);

  async function createRecordingSession() {
    const response = await fetch("/api/recordings/sessions", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("Failed to create recording session");
    }

    const data = (await response.json()) as { sessionId: string };
    return data.sessionId;
  }

  async function uploadChunk(localChunk: LocalChunk) {
    const payload = await readChunkFromOpfs(
      localChunk.sessionId,
      localChunk.sequenceNo,
    );
    if (!payload) {
      throw new Error("Chunk missing from OPFS before upload");
    }

    const response = await fetch(
      `/api/recordings/chunks/${localChunk.chunkId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "audio/webm;codecs=opus",
          "x-session-id": localChunk.sessionId,
          "x-sequence-no": String(localChunk.sequenceNo),
          "x-sha256": localChunk.sha256,
          "x-size-bytes": String(localChunk.sizeBytes),
        },
        body: payload,
      },
    );

    if (!response.ok) {
      const payloadJson = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      const retryable = response.status >= 500;
      throw new UploadChunkError(
        payloadJson?.error ?? "Chunk upload failed",
        retryable,
      );
    }

    return (await response.json()) as { ackedAt?: string };
  }

  async function uploadChunkWithRetry(localChunk: LocalChunk) {
    for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt += 1) {
      updateChunkState(localChunk.chunkId, "uploading", {
        retryCount: attempt,
      });

      try {
        const ack = await uploadChunk(localChunk);
        updateChunkState(localChunk.chunkId, "acked", {
          retryCount: attempt,
          ackedAt: ack.ackedAt,
        });
        return;
      } catch (error) {
        if (error instanceof UploadChunkError && !error.retryable) {
          updateChunkState(localChunk.chunkId, "failed", {
            retryCount: attempt,
          });
          throw error;
        }

        if (attempt === MAX_UPLOAD_RETRIES) {
          updateChunkState(localChunk.chunkId, "failed", {
            retryCount: attempt,
          });
          throw error;
        }

        updateChunkState(localChunk.chunkId, "queued", {
          retryCount: attempt,
        });
        await wait(500 * 2 ** attempt);
      }
    }
  }

  async function repairChunk(chunkId: string, payload: Blob) {
    const response = await fetch(`/api/recordings/repair/${chunkId}`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/webm;codecs=opus",
      },
      body: payload,
    });

    if (!response.ok) {
      const payloadJson = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(payloadJson?.error ?? "Repair upload failed");
    }
  }

  async function finalizeRecording(
    currentSessionId: string,
    lastSequenceNo: number,
    retriesLeft = MAX_FINALIZE_RETRIES,
  ) {
    const response = await fetch(
      `/api/recordings/sessions/${currentSessionId}/finalize`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedLastSequenceNo: lastSequenceNo }),
      },
    );

    const data = (await response.json().catch(() => ({}))) as FinalizeResponse;

    if (response.ok) {
      return data;
    }

    if (response.status === 409 && retriesLeft > 0) {
      const missingChunkIds = Array.isArray(data.missingChunkIds)
        ? data.missingChunkIds
        : [];
      const missingSequences = Array.isArray(data.missingSequences)
        ? data.missingSequences
        : [];

      if (missingChunkIds.length === 0 && missingSequences.length === 0) {
        throw new Error(
          "Finalize requested repair but no missing coverage details were provided",
        );
      }

      setStatusWithRef("repairing");

      for (const missingSequence of missingSequences) {
        const localChunk = chunksRef.current.find(
          (chunk) => chunk.sequenceNo === missingSequence,
        );

        if (!localChunk) {
          throw new Error(
            `Missing local chunk metadata for sequence ${missingSequence}`,
          );
        }

        await uploadChunkWithRetry(localChunk);
      }

      for (const missingChunkId of missingChunkIds) {
        const [, sequenceNoText] = missingChunkId.split(":");
        const sequenceNo = Number(sequenceNoText);

        if (Number.isNaN(sequenceNo) || sequenceNo < 0) {
          continue;
        }

        const payload = await readChunkFromOpfs(currentSessionId, sequenceNo);
        if (!payload) {
          throw new Error(
            `Missing local OPFS chunk for repair sequence ${sequenceNo}`,
          );
        }

        await repairChunk(missingChunkId, payload);
        updateChunkState(missingChunkId, "acked");
      }

      return finalizeRecording(
        currentSessionId,
        lastSequenceNo,
        retriesLeft - 1,
      );
    }

    const message =
      typeof data?.error === "string"
        ? data.error
        : "Finalize failed or repair required";
    throw new Error(message);
  }

  async function startTranscription(currentSessionId: string) {
    const response = await fetch(
      `/api/transcriptions/${currentSessionId}/start`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      const payloadJson = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(payloadJson?.error ?? "Failed to start transcription");
    }
  }

  async function pollTranscription(currentSessionId: string) {
    setTranscriptionStatus("running");

    for (let attempt = 0; attempt < MAX_TRANSCRIPTION_POLLS; attempt += 1) {
      const response = await fetch(
        `/api/transcriptions/${currentSessionId}/status`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch transcription status");
      }

      const data = (await response.json()) as TranscriptionStatusResponse;
      const statusValue = data.status ?? "unknown";
      setTranscriptionStatus(statusValue);

      if (statusValue === "completed") {
        const resultResponse = await fetch(
          `/api/transcriptions/${currentSessionId}/result`,
        );

        if (!resultResponse.ok) {
          throw new Error("Failed to fetch transcription result");
        }

        const result =
          (await resultResponse.json()) as TranscriptionResultResponse;
        setTranscript((result.fullText ?? "").trim());

        return {
          status: "completed" as const,
        };
      }

      if (statusValue === "failed") {
        return {
          status: "failed" as const,
          errorMessage: data.errorMessage ?? "Transcription failed",
        };
      }

      await wait(TRANSCRIPTION_POLL_INTERVAL_MS);
    }

    return {
      status: "timeout" as const,
      errorMessage: "Transcription polling timed out",
    };
  }

  async function waitForInFlightUploadsToSettle() {
    let idleCycles = 0;

    for (let cycle = 0; cycle < STOP_UPLOAD_SETTLE_MAX_CYCLES; cycle += 1) {
      const pendingUploads = [...pendingUploadsRef.current];

      if (pendingUploads.length > 0) {
        idleCycles = 0;
        await Promise.allSettled(pendingUploads);
        continue;
      }

      idleCycles += 1;
      if (idleCycles >= STOP_UPLOAD_IDLE_CYCLES) {
        return;
      }

      await wait(STOP_UPLOAD_SETTLE_MS);
    }
  }

  async function flushPendingChunks(currentSessionId: string) {
    for (let round = 0; round < FINAL_FLUSH_ROUNDS; round += 1) {
      await waitForInFlightUploadsToSettle();

      const pendingChunks = chunksRef.current.filter(
        (chunk) =>
          chunk.sessionId === currentSessionId &&
          (chunk.state === "persisted" ||
            chunk.state === "queued" ||
            chunk.state === "repair_needed"),
      );

      if (pendingChunks.length === 0) {
        return;
      }

      for (const chunk of pendingChunks) {
        await uploadChunkWithRetry(chunk);
      }
    }
  }

  async function finalizeAndPoll(
    currentSessionId: string,
    lastSequenceNo: number,
  ) {
    if (lastSequenceNo < 0) {
      setStatusWithRef("stopped_no_data");
      return;
    }

    setStatusWithRef("flushing");
    await flushPendingChunks(currentSessionId);
    await waitForInFlightUploadsToSettle();

    const remainingChunks = chunksRef.current.filter(
      (chunk) =>
        chunk.sessionId === currentSessionId && chunk.state !== "acked",
    );

    if (remainingChunks.length > 0) {
      const pendingSummary = remainingChunks
        .map((chunk) => `${chunk.sequenceNo}:${chunk.state}`)
        .join(", ");

      throw new Error(
        `Some chunks were not acked after retries (${pendingSummary})`,
      );
    }

    setStatusWithRef("finalizing");
    await finalizeRecording(currentSessionId, lastSequenceNo);

    setStatusWithRef("transcribing");
    await startTranscription(currentSessionId);
    const transcriptionResult = await pollTranscription(currentSessionId);

    if (transcriptionResult.status === "completed") {
      setStatusWithRef("completed");

      if (typeof window !== "undefined") {
        window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      }

      await removeSessionFromOpfs(currentSessionId);
      return;
    }

    setStatusWithRef("failed");
    setError(transcriptionResult.errorMessage ?? "Transcription failed");
  }

  useEffect(() => {
    let disposed = false;

    async function recoverSessionFromManifest() {
      if (typeof window === "undefined") {
        return;
      }

      const activeSessionId = window.localStorage.getItem(
        ACTIVE_SESSION_STORAGE_KEY,
      );

      if (!activeSessionId) {
        return;
      }

      statusRef.current = "recovering";
      setStatus("recovering");
      const manifest = await readSessionManifest(activeSessionId);

      if (!manifest) {
        window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
        statusRef.current = "idle";
        setStatus("idle");
        return;
      }

      if (disposed) {
        return;
      }

      sessionIdRef.current = activeSessionId;
      setSessionId(activeSessionId);
      sequenceRef.current = Math.max(0, manifest.nextSequenceNo);
      chunksRef.current = manifest.chunks;
      setChunks(manifest.chunks);
      statusRef.current = "idle";
      setStatus("idle");
      setError(
        "Recovered local session from OPFS manifest. Use Resume Finalize to continue.",
      );
    }

    void recoverSessionFromManifest();

    return () => {
      disposed = true;

      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, []);

  async function resumeFinalize() {
    if (!sessionIdRef.current) {
      return;
    }

    try {
      setError(null);
      const inferredLastSequenceNo = chunksRef.current.reduce(
        (max, chunk) => Math.max(max, chunk.sequenceNo),
        -1,
      );

      await finalizeAndPoll(sessionIdRef.current, inferredLastSequenceNo);
    } catch (resumeError) {
      const message =
        resumeError instanceof Error ? resumeError.message : "Resume failed";
      setError(message);
      setStatusWithRef("failed");
    }
  }

  async function startRecording() {
    try {
      setError(null);
      setTranscript("");
      setTranscriptionStatus("not_started");
      setStatusWithRef("preparing");
      setChunksWithRef(() => []);
      sequenceRef.current = 0;

      const createdSessionId = await createRecordingSession();
      sessionIdRef.current = createdSessionId;
      setSessionId(createdSessionId);

      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          ACTIVE_SESSION_STORAGE_KEY,
          createdSessionId,
        );
      }

      await persistManifest([], "preparing", 0);

      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
      }

      heartbeatRef.current = setInterval(() => {
        void fetch(`/api/recordings/sessions/${createdSessionId}/heartbeat`, {
          method: "PATCH",
        });
      }, 20000);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: CHUNK_MIME_TYPE });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size === 0) {
          return;
        }

        // Sequence number is monotonic and used to build deterministic chunk ids.
        const sequenceNo = sequenceRef.current;
        sequenceRef.current += 1;

        const uploadTask = (async () => {
          try {
            const sha256 = await digestSha256(event.data);
            const chunkId = `${createdSessionId}:${sequenceNo}:${sha256}`;
            const opfsPath = await writeChunkToOpfs(
              createdSessionId,
              sequenceNo,
              event.data,
            );

            const newChunk: LocalChunk = {
              chunkId,
              sessionId: createdSessionId,
              sequenceNo,
              sha256,
              sizeBytes: event.data.size,
              opfsPath,
              state: "persisted",
              retryCount: 0,
            };

            setChunksWithRef((previous) => [...previous, newChunk]);

            // Upload only after OPFS persistence succeeds.
            updateChunkState(chunkId, "queued");
            await uploadChunkWithRetry(newChunk);
          } catch (chunkError) {
            const message =
              chunkError instanceof Error
                ? chunkError.message
                : "Chunk handling failed";

            setError(message);
            setStatusWithRef("failed");

            const failedChunk = chunksRef.current.find(
              (chunk) => chunk.sequenceNo === sequenceNo,
            );

            if (failedChunk) {
              updateChunkState(failedChunk.chunkId, "failed");
            }

            if (recorder.state !== "inactive") {
              recorder.stop();
            }
          }
        })();

        pendingUploadsRef.current.add(uploadTask);
        void uploadTask.finally(() => {
          pendingUploadsRef.current.delete(uploadTask);
        });
      };

      recorder.onstop = async () => {
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }

        const lastSequenceNo = sequenceRef.current - 1;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        await waitForInFlightUploadsToSettle();

        try {
          // Finalize first, then poll transcription status.
          await finalizeAndPoll(createdSessionId, lastSequenceNo);
        } catch (finalizeError) {
          const message =
            finalizeError instanceof Error
              ? finalizeError.message
              : "Finalize failed";
          setError(message);
          setStatusWithRef("failed");
        }
      };

      recorder.start(CHUNK_INTERVAL_MS);
      setStatusWithRef("recording");
    } catch (startError) {
      const message =
        startError instanceof Error ? startError.message : "Start failed";
      setError(message);
      setStatusWithRef("failed");
    }
  }

  function stopRecording() {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      setStatusWithRef("stopping");
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  }

  const chunkStateSummary = useMemo(() => {
    return chunks.reduce<Record<string, number>>((summary, chunk) => {
      summary[chunk.state] = (summary[chunk.state] ?? 0) + 1;
      return summary;
    }, {});
  }, [chunks]);

  const canResumeFinalize =
    !!sessionId &&
    status !== "recording" &&
    status !== "preparing" &&
    status !== "transcribing";

  const isBusy =
    status === "recovering" ||
    status === "preparing" ||
    status === "stopping" ||
    status === "flushing" ||
    status === "finalizing" ||
    status === "repairing" ||
    status === "transcribing";

  const primaryStatusText = useMemo(() => {
    switch (status) {
      case "idle":
        return "Ready to record.";
      case "recovering":
        return "Recovering local session from OPFS...";
      case "preparing":
        return "Preparing microphone and session...";
      case "recording":
        return "Recording in progress.";
      case "stopping":
        return "Stopping recorder and waiting for final chunks...";
      case "flushing":
        return "Ensuring all chunks are uploaded...";
      case "finalizing":
        return "Finalizing durable session...";
      case "repairing":
        return "Repairing missing chunks from local OPFS...";
      case "transcribing":
        return "Transcribing full recording...";
      case "completed":
        return "Transcript is ready.";
      case "stopped_no_data":
        return "Recording stopped with no audio chunks.";
      case "failed":
        return "Flow failed. Review diagnostics and retry.";
      default:
        return "Working...";
    }
  }, [status]);

  const stopButtonLabel =
    status === "recording"
      ? "Stop Recording"
      : status === "stopping" ||
          status === "flushing" ||
          status === "finalizing" ||
          status === "repairing"
        ? "Stopping..."
        : "Stop Recording";

  const transcriptPlaceholder = useMemo(() => {
    if (status === "recording") {
      return "Transcript will appear after you stop recording and processing completes.";
    }

    if (status === "transcribing") {
      return "Transcription in progress. Please wait...";
    }

    if (status === "failed") {
      return "No transcript available due to a processing error.";
    }

    return "Start recording to generate a transcript.";
  }, [status]);

  return (
    <main className="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">
            Reliable Recording Pipeline
          </h1>
          <p className="text-sm text-neutral-600">
            Transcript-first view. Technical diagnostics are available in the
            side panel.
          </p>
        </header>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={startRecording}
            disabled={status === "recording" || isBusy}
            className="rounded bg-black px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "recording" ? "Recording..." : "Start Recording"}
          </button>
          <button
            type="button"
            onClick={stopRecording}
            disabled={status !== "recording"}
            className="rounded border border-black px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stopButtonLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              void resumeFinalize();
            }}
            disabled={!canResumeFinalize}
            className="rounded border border-black px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Resume Finalize
          </button>
        </div>

        <div className="rounded border border-neutral-200 bg-neutral-50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            {isBusy ? (
              <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />
            ) : (
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" />
            )}
            {primaryStatusText}
          </div>
          <p className="mt-1 text-xs text-neutral-600">
            Current stage: {status} • transcription: {transcriptionStatus}
          </p>
        </div>

        {error ? (
          <p className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <section className="rounded border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-lg font-medium">Transcript</h2>
          {transcript ? (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-3 text-sm leading-6">
              {transcript}
            </pre>
          ) : (
            <p className="rounded bg-neutral-50 p-3 text-sm text-neutral-600">
              {transcriptPlaceholder}
            </p>
          )}
        </section>
      </section>

      <aside className="space-y-4">
        <section className="rounded border border-neutral-200 bg-white p-4 text-sm">
          <h2 className="mb-2 text-base font-semibold">Session Info</h2>
          <div className="space-y-1 text-neutral-700">
            <p>Status: {status}</p>
            <p>Session: {sessionId ?? "n/a"}</p>
            <p>OPFS: {opfsSupportText}</p>
            <p>Chunks: {chunks.length}</p>
            <p>Transcription: {transcriptionStatus}</p>
            <p>
              Chunk states:{" "}
              {Object.entries(chunkStateSummary)
                .map(([key, value]) => `${key}=${value}`)
                .join(", ") || "none"}
            </p>
          </div>
        </section>

        <details className="rounded border border-neutral-200 bg-white p-4 text-sm">
          <summary className="cursor-pointer font-semibold">
            Diagnostics (Chunk Metadata)
          </summary>
          <ul className="mt-3 max-h-[360px] space-y-2 overflow-auto">
            {chunks.length === 0 ? (
              <li className="text-neutral-600">No chunk metadata yet.</li>
            ) : (
              chunks
                .slice(-30)
                .reverse()
                .map((chunk) => (
                  <li key={chunk.chunkId} className="rounded border p-2">
                    <p>sequence_no: {chunk.sequenceNo}</p>
                    <p>state: {chunk.state}</p>
                    <p>size_bytes: {chunk.sizeBytes}</p>
                    <p>retry_count: {chunk.retryCount}</p>
                    <p className="truncate" title={chunk.opfsPath}>
                      opfs_path: {chunk.opfsPath}
                    </p>
                  </li>
                ))
            )}
          </ul>
        </details>
      </aside>
    </main>
  );
}
