"use client";
import { API_URL, api, unwrap, type Schemas } from "./api";
import { session } from "./auth";

export type UploadPurpose = "boundary-import" | "observation-photo" | "verification-evidence" | "asset-model";

/** Accepted types per purpose; mirrors the API's allow-list. */
export const ACCEPT: Record<UploadPurpose, string[]> = {
  "boundary-import": ["application/geo+json"],
  "observation-photo": ["image/jpeg", "image/png", "image/webp"],
  "verification-evidence": ["application/pdf", "image/jpeg", "image/png"],
  "asset-model": ["model/gltf-binary"],
};

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Uploads a file in three steps: ask the API for an upload ticket, send the
 * bytes (to storage directly, or to the API in proxy mode), then confirm.
 * Returns the confirmed media object.
 */
export async function uploadFile(opts: { tenantId: string; file: File; purpose: UploadPurpose; farmId?: string }): Promise<Schemas["MediaObject"]> {
  const { tenantId, file, purpose, farmId } = opts;
  if (!ACCEPT[purpose].includes(file.type)) {
    throw new Error(`${file.name} is a ${file.type || "file of unknown type"}. Accepted: ${ACCEPT[purpose].join(", ")}.`);
  }
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is ${describeSize(file.size)}. The limit is ${describeSize(MAX_UPLOAD_BYTES)}.`);

  const bytes = await file.arrayBuffer();
  const ticket = await unwrap(
    api.POST("/v1/tenants/{tenantId}/uploads", {
      params: { path: { tenantId } },
      body: {
        filename: file.name.slice(0, 200),
        contentType: file.type as never,
        byteSize: file.size,
        sha256: await sha256Hex(bytes),
        purpose,
        ...(farmId ? { farmId } : {}),
      },
    }),
  );

  // In proxy mode the upload URL is on the API and needs the same bearer token.
  const headers: Record<string, string> = { ...(ticket.headers ?? {}) };
  if (ticket.uploadUrl.startsWith(API_URL)) {
    const token = session.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const put = await fetch(ticket.uploadUrl, { method: "PUT", headers, body: bytes });
  if (!put.ok) throw new Error(`Uploading ${file.name} failed (${put.status}). Try again.`);

  return unwrap(
    api.POST("/v1/tenants/{tenantId}/uploads/{mediaId}/complete", { params: { path: { tenantId, mediaId: ticket.mediaId } } }),
  );
}

/** Fetches a stored file with the user's token and returns a blob: URL for display. */
export async function fileObjectUrl(tenantId: string, mediaId: string): Promise<string> {
  const token = session.getToken();
  const r = await fetch(`${API_URL}/v1/tenants/${tenantId}/media/${mediaId}/content`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) throw new Error(`Could not open the file (${r.status}).`);
  return URL.createObjectURL(await r.blob());
}
