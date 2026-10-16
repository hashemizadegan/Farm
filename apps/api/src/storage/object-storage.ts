/**
 * Object storage behind an interface so the API can run against any
 * S3-compatible service (AWS S3, Cloudflare R2, MinIO, …) or an in-memory
 * fake in tests. The API only issues short-lived signed URLs; file bytes go
 * directly from the browser to storage.
 */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  byteSize: number;
  contentType: string | undefined;
}

export interface ObjectStorage {
  presignPut(key: string, opts: { contentType: string; byteSize: number; ttlSeconds: number }): Promise<PresignedUpload>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<StoredObjectInfo | undefined>;
  delete(key: string): Promise<void>;
  ping(): Promise<boolean>;
}

/** Storage keys never include user-supplied file names (prevents traversal and leaks). */
export function buildStorageKey(tenantId: string, purpose: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !/^[0-9a-f-]{36}$/.test(id) || !/^[a-z-]{1,40}$/.test(purpose)) {
    throw new Error("invalid storage key components");
  }
  return `tenants/${tenantId}/${purpose}/${id}`;
}
