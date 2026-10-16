import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "./object-storage";

export interface S3StorageOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * S3-compatible storage. TODO(provider-config): set S3_* variables for your
 * provider and configure the bucket's CORS policy to allow PUT from the web
 * origin with the `content-type` header. Keep the bucket private; reads go
 * through presigned GET URLs.
 */
export function createS3Storage(opts: S3StorageOptions): ObjectStorage {
  const client = new S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
    forcePathStyle: opts.forcePathStyle,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });

  return {
    async presignPut(key, { contentType, byteSize, ttlSeconds }) {
      const cmd = new PutObjectCommand({
        Bucket: opts.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: byteSize,
      });
      const url = await getSignedUrl(client, cmd, {
        expiresIn: ttlSeconds,
        // Bind these headers into the signature so the client cannot change them.
        signableHeaders: new Set(["content-type", "content-length"]),
      });
      return {
        url,
        method: "PUT",
        headers: { "content-type": contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      };
    },
    async presignGet(key, ttlSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), { expiresIn: ttlSeconds });
    },
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: opts.bucket, Key: key }));
        return { byteSize: r.ContentLength ?? 0, contentType: r.ContentType };
      } catch (err) {
        if ((err as { name?: string }).name === "NotFound") return undefined;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }));
    },
    async ping() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: opts.bucket }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
