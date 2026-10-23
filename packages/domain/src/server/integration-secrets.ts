import { createHash, createHmac } from "node:crypto";

/**
 * An integration's signing secret, derived on the server (migration 0031): HMAC-SHA256 of the integration id and
 * secret version under INTEGRATION_SECRET_KEY. Nothing stores the secret; the database keeps its SHA-256 only.
 * Rotation increments the version, so the previous secret stops verifying at once.
 */
export function deriveIntegrationSecret(serverKey: string, integrationId: string, version: number): string {
  if (serverKey.length < 32) throw new Error("INTEGRATION_SECRET_KEY must be at least 32 characters");
  if (!Number.isInteger(version) || version < 1) throw new Error("secret versions start at 1");
  const mac = createHmac("sha256", serverKey).update(`metafarm-integration/1:${integrationId.toLowerCase()}:${version}`).digest("base64url");
  return `mfi_${mac}`;
}

export const integrationSecretSha256 = (secret: string): string => createHash("sha256").update(secret).digest("hex");
