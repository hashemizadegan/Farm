import { describe, expect, it } from "vitest";
import { deriveIntegrationSecret, integrationSecretSha256 } from "./integration-secrets";
import { signWebhook, verifyWebhookSignature } from "./webhooks";

const KEY = "k".repeat(40);
const ID = "44444444-4444-4444-8444-444444444444";

describe("integration secrets", () => {
  it("are derived, not stored: deterministic per integration and version, different after rotation or a new key", () => {
    const v1 = deriveIntegrationSecret(KEY, ID, 1);
    expect(v1).toMatch(/^mfi_[A-Za-z0-9_-]{43}$/);
    expect(deriveIntegrationSecret(KEY, ID.toUpperCase(), 1)).toBe(v1);
    expect(deriveIntegrationSecret(KEY, ID, 2)).not.toBe(v1);
    expect(deriveIntegrationSecret("j".repeat(40), ID, 1)).not.toBe(v1);
    expect(integrationSecretSha256(v1)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => deriveIntegrationSecret("short", ID, 1)).toThrow(/32 characters/);
    expect(() => deriveIntegrationSecret(KEY, ID, 0)).toThrow();
  });

  it("sign with the platform's webhook scheme; a rotated secret stops verifying", () => {
    const body = JSON.stringify({ id: "e1" });
    const now = 1_800_000_000;
    const header = signWebhook(deriveIntegrationSecret(KEY, ID, 1), body, now);
    expect(verifyWebhookSignature({ header, rawBody: body, secrets: [deriveIntegrationSecret(KEY, ID, 1)], toleranceSeconds: 300, nowSeconds: now }).ok).toBe(true);
    expect(verifyWebhookSignature({ header, rawBody: body, secrets: [deriveIntegrationSecret(KEY, ID, 2)], toleranceSeconds: 300, nowSeconds: now }).ok).toBe(false);
  });
});
