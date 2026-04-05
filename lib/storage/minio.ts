import { Client } from "minio";

import { getServerEnv } from "@/lib/env";

let minioClient: Client | null = null;
let ensureBucketPromise: Promise<void> | null = null;

export function getMinioClient() {
  if (minioClient) {
    return minioClient;
  }

  const env = getServerEnv();

  minioClient = new Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });

  return minioClient;
}

export function getRecordingBucketName() {
  return getServerEnv().MINIO_BUCKET;
}

export function getChunkBucketKey(
  sessionId: string,
  sequenceNo: number,
  sha256: string,
) {
  return `recordings/${sessionId}/${sequenceNo}-${sha256}.webm`;
}

export async function ensureRecordingBucketExists() {
  if (!ensureBucketPromise) {
    ensureBucketPromise = (async () => {
      const client = getMinioClient();
      const bucketName = getRecordingBucketName();
      const exists = await client.bucketExists(bucketName);
      if (!exists) {
        await client.makeBucket(bucketName);
      }
    })().catch((error) => {
      ensureBucketPromise = null;
      throw error;
    });
  }

  await ensureBucketPromise;
}

export async function statObjectIfExists(bucketKey: string) {
  try {
    const client = getMinioClient();
    const bucketName = getRecordingBucketName();
    return await client.statObject(bucketName, bucketKey);
  } catch {
    return null;
  }
}
