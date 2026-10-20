import { createMemoryStorage } from "./memory";
import type { ObjectStorage } from "./object-storage";
import { createS3Storage } from "./s3";

/** The storage settings every service shares (packages/config `storage`). */
export interface StorageEnv {
  STORAGE_DRIVER: "s3" | "memory";
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE: boolean;
}

export function createStorageFromEnv(env: StorageEnv): ObjectStorage {
  if (env.STORAGE_DRIVER === "memory") return createMemoryStorage();
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for s3 storage");
  }
  return createS3Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}
