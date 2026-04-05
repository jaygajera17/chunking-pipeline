import { Client } from "minio";

import { getServerEnv } from "@/lib/env";

let minioClient: Client | null = null;

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
