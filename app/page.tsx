"use client";

import { useMemo, useRef, useState } from "react";

type ChunkState =
  | "persisted"
  | "queued"
  | "uploading"
  | "acked"
  | "repair_needed"
  | "failed";

type LocalChunk = {
  chunkId: string;
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  opfsPath: string;
  state: ChunkState;
};

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

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [chunks, setChunks] = useState<LocalChunk[]>([]);
  const [transcriptionStatus, setTranscriptionStatus] = useState("not_started");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(0);

  const opfsSupportText = useMemo(() => {
    return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory
      ? "supported"
      : "not_supported";
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
    const response = await fetch(
      `/api/recordings/chunks/${localChunk.chunkId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          sequenceNo: localChunk.sequenceNo,
          sha256: localChunk.sha256,
          sizeBytes: localChunk.sizeBytes,
          mimeType: "audio/webm;codecs=opus",
        }),
      },
    );

    if (!response.ok) {
      throw new Error("Chunk upload failed");
    }
  }

  async function finalizeRecording(
    currentSessionId: string,
    lastSequenceNo: number,
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

    const data = await response.json();
    if (!response.ok) {
      const message =
        typeof data?.error === "string"
          ? data.error
          : "Finalize failed or repair required";
      throw new Error(message);
    }

    return data;
  }

  async function pollTranscription(currentSessionId: string) {
    setTranscriptionStatus("running");

    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetch(
        `/api/transcriptions/${currentSessionId}/status`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch transcription status");
      }

      const data = (await response.json()) as { status?: string };
      const statusValue = data.status ?? "unknown";
      setTranscriptionStatus(statusValue);

      if (statusValue === "completed" || statusValue === "failed") {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function startRecording() {
    try {
      setError(null);
      setStatus("preparing");
      setChunks([]);
      sequenceRef.current = 0;

      const createdSessionId = await createRecordingSession();
      setSessionId(createdSessionId);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = "audio/webm;codecs=opus";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size === 0) {
          return;
        }

        const sequenceNo = sequenceRef.current;
        sequenceRef.current += 1;

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
            sequenceNo,
            sha256,
            sizeBytes: event.data.size,
            opfsPath,
            state: "persisted",
          };

          setChunks((previous) => [...previous, newChunk]);

          await uploadChunk(newChunk);

          setChunks((previous) =>
            previous.map((chunk) =>
              chunk.chunkId === newChunk.chunkId
                ? { ...chunk, state: "acked" }
                : chunk,
            ),
          );
        } catch (chunkError) {
          const message =
            chunkError instanceof Error
              ? chunkError.message
              : "Chunk handling failed";
          setError(message);
          setStatus("failed");
          recorder.stop();
        }
      };

      recorder.onstop = async () => {
        const lastSequenceNo = sequenceRef.current - 1;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        if (lastSequenceNo < 0) {
          setStatus("stopped_no_data");
          return;
        }

        try {
          setStatus("finalizing");
          await finalizeRecording(createdSessionId, lastSequenceNo);
          setStatus("finalized");
          await pollTranscription(createdSessionId);
          setStatus("completed");
        } catch (finalizeError) {
          const message =
            finalizeError instanceof Error
              ? finalizeError.message
              : "Finalize failed";
          setError(message);
          setStatus("failed");
        }
      };

      recorder.start(5000);
      setStatus("recording");
    } catch (startError) {
      const message =
        startError instanceof Error ? startError.message : "Start failed";
      setError(message);
      setStatus("failed");
    }
  }

  function stopRecording() {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      setStatus("stopping");
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold">Reliable Recording Bootstrap</h1>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={startRecording}
          disabled={status === "recording"}
          className="rounded bg-black px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start Recording
        </button>
        <button
          type="button"
          onClick={stopRecording}
          disabled={status !== "recording"}
          className="rounded border border-black px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Stop Recording
        </button>
      </div>

      <div className="space-y-1 text-sm">
        <p>Status: {status}</p>
        <p>Session: {sessionId ?? "n/a"}</p>
        <p>OPFS: {opfsSupportText}</p>
        <p>Chunks: {chunks.length}</p>
        <p>Transcription: {transcriptionStatus}</p>
      </div>

      {error ? (
        <p className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-medium">Recent Chunks</h2>
        <ul className="space-y-2 text-sm">
          {chunks.slice(-10).map((chunk) => (
            <li key={chunk.chunkId} className="rounded border p-2">
              <p>sequence_no: {chunk.sequenceNo}</p>
              <p>state: {chunk.state}</p>
              <p>size_bytes: {chunk.sizeBytes}</p>
              <p>opfs_path: {chunk.opfsPath}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
