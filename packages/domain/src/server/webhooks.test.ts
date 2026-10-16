import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "./webhooks";
import { generateNonce } from "./crypto";

const body = JSON.stringify({ id: "evt_1", type: "sensor.reading" });
const now = 1_760_000_000;

describe("webhook signatures", () => {
  it("verifies a valid signature", () => {
    const header = signWebhook("s1", body, now);
    expect(verifyWebhookSignature({ header, rawBody: body, secrets: ["s1"], toleranceSeconds: 300, nowSeconds: now }).ok).toBe(true);
  });

  it("supports secret rotation", () => {
    const header = signWebhook("old", body, now);
    expect(
      verifyWebhookSignature({ header, rawBody: body, secrets: ["new", "old"], toleranceSeconds: 300, nowSeconds: now }).ok,
    ).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps and junk", () => {
    const header = signWebhook("s1", body, now);
    const v = (h: string | undefined, b = body, n = now, secrets = ["s1"]) =>
      verifyWebhookSignature({ header: h, rawBody: b, secrets, toleranceSeconds: 300, nowSeconds: n });
    expect(v(header, body.replace("evt_1", "evt_2"))).toEqual({ ok: false, reason: "mismatch" });
    expect(v(header, body, now, ["other"])).toEqual({ ok: false, reason: "mismatch" });
    expect(v(header, body, now + 301)).toEqual({ ok: false, reason: "stale" });
    expect(v(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(v("t=abc,v1=xyz")).toEqual({ ok: false, reason: "malformed" });
    expect(v(header, body, now, [])).toEqual({ ok: false, reason: "no-secrets" });
  });
});

describe("generateNonce", () => {
  it("is alphanumeric, the requested length, and unique", () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(generateNonce()).not.toBe(a);
  });
});
