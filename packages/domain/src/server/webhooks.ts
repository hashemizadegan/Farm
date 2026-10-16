import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures: header `x-webhook-signature: t=<unix seconds>,v1=<hex hmac>`
 * where the HMAC-SHA256 is computed over `${t}.${rawBody}`.
 *
 * - The raw request body must be used (not re-serialised JSON).
 * - Several secrets may be active at once to allow rotation.
 * - Signatures outside the tolerance window are rejected to limit replay;
 *   callers should additionally de-duplicate on the provider's event id.
 */

export type WebhookVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" | "no-secrets" };

export function signWebhook(secret: string, rawBody: string | Buffer, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(opts: {
  header: string | undefined;
  rawBody: string | Buffer;
  secrets: readonly string[];
  toleranceSeconds: number;
  nowSeconds?: number;
}): WebhookVerifyResult {
  if (opts.secrets.length === 0) return { ok: false, reason: "no-secrets" };
  if (!opts.header) return { ok: false, reason: "missing" };
  if (opts.header.length > 1_024) return { ok: false, reason: "malformed" };

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of opts.header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === undefined || signatures.length === 0) return { ok: false, reason: "malformed" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > opts.toleranceSeconds) return { ok: false, reason: "stale" };

  for (const secret of opts.secrets) {
    const expected = Buffer.from(
      createHmac("sha256", secret).update(`${timestamp}.`).update(opts.rawBody).digest("hex"),
      "hex",
    );
    for (const sig of signatures) {
      const got = Buffer.from(sig, "hex");
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, timestamp };
    }
  }
  return { ok: false, reason: "mismatch" };
}
