import { describe, expect, it } from "vitest";
import { QUEUES, backoffDelayMs, idempotencyKey, jobIdFromKey, timeBucket } from "./jobs";

describe("jobs", () => {
  it("derives stable idempotency keys", () => {
    const p = { tenantId: "t", farmId: "f", boundaryVersionId: "b" };
    expect(idempotencyKey(QUEUES.gis, p)).toBe(idempotencyKey(QUEUES.gis, { ...p }));
    expect(idempotencyKey(QUEUES.gis, p)).toBe("gis:t:b");
  });

  it("normalises contract addresses in chain keys", () => {
    const a = idempotencyKey(QUEUES.chain, { chainId: 1, contractAddress: "0xABC", fromBlock: "1", toBlock: "2" });
    const b = idempotencyKey(QUEUES.chain, { chainId: 1, contractAddress: "0xabc", fromBlock: "1", toBlock: "2" });
    expect(a).toBe(b);
  });

  it("produces BullMQ-safe job ids", () => {
    expect(jobIdFromKey("gis:t:b")).toBe("gis_t_b");
  });

  it("backs off exponentially with a cap", () => {
    const max = () => 0.999999;
    expect(backoffDelayMs(1, 1000, 60_000, max)).toBe(999);
    expect(backoffDelayMs(3, 1000, 60_000, max)).toBe(3999);
    expect(backoffDelayMs(20, 1000, 60_000, max)).toBe(59_999);
    expect(backoffDelayMs(3, 1000, 60_000, () => 0)).toBe(0);
  });

  it("buckets time to five minutes", () => {
    expect(timeBucket(new Date("2026-01-01T10:07:59Z"))).toBe("2026-01-01T10:05:00.000Z");
  });
});
