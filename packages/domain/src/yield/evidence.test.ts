import { describe, expect, it } from "vitest";
import { type YieldEvidenceError, assertEvidenceBytes, buildEvidenceManifest, canonicalEvidenceManifest, evidenceItemProblems, evidenceManifestHash, type EvidenceItem } from "./evidence";

const enc = (s: string) => new TextEncoder().encode(s);
// SHA-256 of the UTF-8 strings, computed independently (Python hashlib).
const H = {
  invoice1: "ed8d97c08bf3add20118c75a4e92eb49af62ed9b602a6e60b3e5e87e440f5726",
  bank1: "5436e7948ad1df5d02e9d2e310ab6cc9b60f3055d093d69ae1fb32a525738982",
  invoice2: "e55ceae6b520265d5cb996f96d928994a557a468bf2a2572e8017d57388d5ffa",
};

function item(type: EvidenceItem["type"], contentSha256: string, byteSize: number, sourceId: string): EvidenceItem {
  return {
    type,
    contentSha256,
    byteSize,
    mediaType: "application/pdf",
    issuedAt: "2026-09-30T10:00:00+03:30",
    timeZone: "Asia/Tehran",
    sourceId,
    recordedBy: "user-1",
    recordedAt: "2026-10-01T08:00:00Z",
    classification: "confidential",
    retentionClassId: "simulation-retention",
    supersedes: null,
  };
}
const a = item("sales_invoice", H.invoice1, 9, "INV-1");
const b = item("bank_settlement_record", H.bank1, 6, "BANK-1");
const c = item("sales_invoice", H.invoice2, 9, "INV-2");
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as YieldEvidenceError).code;
  }
  return "no error";
};

describe("evidence manifest", () => {
  it("sorts items by (type, contentSha256) and matches an independently computed hash vector", async () => {
    const m = buildEvidenceManifest({ cycleId: "sim-cycle-1", cycleVersion: 1, items: [a, b, c] });
    expect(m.scheme).toBe("metafarm-yield-evidence/1");
    expect(m.items.map((x) => x.sourceId)).toEqual(["BANK-1", "INV-2", "INV-1"]);
    // Python: json.dumps(manifest, sort_keys=True, separators=(",", ":")) → hashlib.sha256.
    expect(await evidenceManifestHash(m)).toBe("66b5c5c3b020bb7edff411190676ca8cca11b1733a0aa03c4848b96ae51bffb2");
  });

  it("is reproducible whatever the input order", async () => {
    const x = buildEvidenceManifest({ cycleId: "sim-cycle-1", cycleVersion: 1, items: [c, a, b] });
    const y = buildEvidenceManifest({ cycleId: "sim-cycle-1", cycleVersion: 1, items: [b, c, a] });
    expect(canonicalEvidenceManifest(x)).toBe(canonicalEvidenceManifest(y));
    expect(await evidenceManifestHash({ ...x, items: [...x.items].reverse() })).toBe(await evidenceManifestHash(y));
  });

  it("changes when the cycle version or any item changes", async () => {
    const h = await evidenceManifestHash(buildEvidenceManifest({ cycleId: "sim-cycle-1", cycleVersion: 1, items: [a] }));
    expect(await evidenceManifestHash(buildEvidenceManifest({ cycleId: "sim-cycle-1", cycleVersion: 2, items: [a] }))).not.toBe(h);
    expect(await evidenceManifestHash(buildEvidenceManifest({ cycleId: "sim-cycle-1", cycleVersion: 1, items: [{ ...a, classification: "restricted" }] }))).not.toBe(h);
  });

  it("refuses duplicates, invalid items, unsupported keys and a wrong scheme", async () => {
    expect(await code(() => buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [a, { ...a, sourceId: "INV-1b" }] }))).toBe("duplicate_evidence");
    expect(await code(() => buildEvidenceManifest({ cycleId: "c", cycleVersion: 0, items: [a] }))).toBe("invalid_evidence");
    expect(await code(() => buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [a], note: "x" } as never))).toBe("invalid_evidence");
    expect(await code(() => canonicalEvidenceManifest({ ...buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [a] }), scheme: "other" } as never))).toBe("invalid_evidence");
    expect(await code(() => canonicalEvidenceManifest({ ...buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [a] }), extra: 1 } as never))).toBe("invalid_evidence");
  });

  it("allows an empty bundle (a zero must be evidenced, but which evidence is required is not decided here)", () => {
    expect(buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [] }).items).toEqual([]);
  });
});

describe("evidence items", () => {
  it("accepts a complete item", () => {
    expect(evidenceItemProblems(a)).toEqual([]);
    expect(evidenceItemProblems({ ...a, issuedAt: "2028-02-29T23:59:59.5-12:00" })).toEqual([]);
    expect(evidenceItemProblems({ ...a, timeZone: null, supersedes: H.bank1 })).toEqual([]);
  });

  it("has no defaults: every field is required, and none is written as null", () => {
    const problems = evidenceItemProblems({});
    expect(problems).toContain("retentionClassId must be given");
    expect(problems).toContain("timeZone must be given (null for none)");
    expect(problems).toContain("supersedes must be given (null for none)");
    expect(problems).toHaveLength(12);
  });

  it("refuses invalid values", () => {
    const bad = (patch: Record<string, unknown>) => expect(evidenceItemProblems({ ...a, ...patch })).toHaveLength(1);
    bad({ type: "photo" });
    bad({ contentSha256: H.invoice1.toUpperCase() });
    bad({ byteSize: 1.5 });
    bad({ byteSize: -1 });
    bad({ byteSize: 2 ** 60 });
    bad({ mediaType: "application/pdf; charset=binary" });
    bad({ issuedAt: "2026-09-30" });
    bad({ issuedAt: "2026-09-30T10:00:00" });
    // Impossible dates and times that Date.parse would roll forward.
    bad({ recordedAt: "2026-02-30T10:00:00Z" });
    bad({ recordedAt: "2025-02-29T10:00:00Z" });
    bad({ recordedAt: "2026-04-31T00:00:00Z" });
    bad({ recordedAt: "2026-01-01T24:00:00Z" });
    bad({ recordedAt: "2026-13-01T00:00:00Z" });
    bad({ recordedAt: "2026-01-01T10:00:00+24:00" });
    bad({ timeZone: "Mars/Olympus" });
    bad({ sourceId: " INV-1" });
    bad({ classification: "public" });
    bad({ retentionClassId: "" });
    bad({ supersedes: H.invoice1 });
    bad({ uploadedTo: "ipfs" });
  });

  it("checks bytes against the recorded size and hash", async () => {
    await expect(assertEvidenceBytes(a, enc("invoice-1"))).resolves.toBeUndefined();
    expect(await code(() => assertEvidenceBytes(a, enc("invoice-X")))).toBe("integrity_mismatch");
    expect(await code(() => assertEvidenceBytes(a, enc("invoice-10")))).toBe("integrity_mismatch");
    expect(await code(() => assertEvidenceBytes(a, "invoice-1" as never))).toBe("invalid_evidence");
  });
});
