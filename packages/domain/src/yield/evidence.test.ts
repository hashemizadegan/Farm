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

describe("manifest determinism: Unicode, collisions and ordering", () => {
  const HX = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"; // SHA-256("x")
  const u = (type: EvidenceItem["type"], contentSha256: string, sourceId: string, recordedBy = "user-1"): EvidenceItem => ({ ...item(type, contentSha256, 1, sourceId), recordedBy });

  it("matches an independent vector with Persian, emoji, control, quote and NFC/NFD characters", async () => {
    const m = buildEvidenceManifest({
      cycleId: "چرخه-۱",
      cycleVersion: 1,
      items: [u("sales_invoice", HX, "فاکتور-۱۲۳", "کاربر-۱"), u("weather_data", HX, 'INV-😀\u0007"\\/'), u("iot_data", "0".repeat(64), "facture-é"), u("customs_record", "f".repeat(64), "facture-é")],
    });
    expect(m.items.map((x) => x.type)).toEqual(["customs_record", "iot_data", "sales_invoice", "weather_data"]);
    // Characters are written as UTF-8, not \u-escaped; control characters, quotes and backslashes are escaped.
    expect(canonicalEvidenceManifest(m)).toContain('"sourceId":"INV-😀\\u0007\\"\\\\/"');
    // Python: json.dumps(m, sort_keys=True, separators=(",", ":"), ensure_ascii=False) → UTF-8 → hashlib.sha256.
    expect(await evidenceManifestHash(m)).toBe("3171a9bf065d37b24e6f9232cf4cc80756f21894a9985cd172a4a175e2054272");
  });

  it("does not normalise Unicode: NFC and NFD spellings of an identifier hash differently", async () => {
    const nfc = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [u("sales_invoice", HX, "facture-é")] });
    const nfd = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [u("sales_invoice", HX, "facture-é")] });
    expect(await evidenceManifestHash(nfc)).not.toBe(await evidenceManifestHash(nfd));
  });

  it("escapes lone surrogates, so they cannot collide with U+FFFD after UTF-8 encoding", async () => {
    const lone = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [u("sales_invoice", HX, "INV-\ud800")] });
    const replacement = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [u("sales_invoice", HX, "INV-�")] });
    expect(canonicalEvidenceManifest(lone)).toContain('"INV-\\ud800"');
    expect(await evidenceManifestHash(lone)).not.toBe(await evidenceManifestHash(replacement));
  });

  it("treats the same bytes under different types as different items, and the same type and bytes as a duplicate", async () => {
    const m = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [u("weather_data", HX, "W"), u("iot_data", HX, "I")] });
    expect(m.items.map((x) => x.type)).toEqual(["iot_data", "weather_data"]);
    expect(await code(() => buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [u("iot_data", HX, "I-1"), u("iot_data", HX, "I-2")] }))).toBe("duplicate_evidence");
  });

  it("orders by type then hash in byte order, whatever the input order (200 items, 25 permutations)", () => {
    // Deterministic pseudo-random generator (mulberry32), so the test is reproducible.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const types = ["weighbridge_receipt", "warehouse_receipt", "sales_invoice", "customs_record", "bank_settlement_record", "stablecoin_settlement_record", "equipment_telemetry", "iot_data", "weather_data", "auditor_attestation"] as const;
    const hexDigit = () => "0123456789abcdef"[Math.floor(rand() * 16)]!;
    const seen = new Set<string>();
    const items: EvidenceItem[] = [];
    while (items.length < 200) {
      const type = types[Math.floor(rand() * types.length)]!;
      // Shared prefixes make the comparison reach deep into the hash.
      const h = (rand() < 0.5 ? "00000000" : "ffff") + Array.from({ length: 64 }, hexDigit).join("");
      const sha = h.slice(0, 64);
      if (seen.has(type + sha)) continue;
      seen.add(type + sha);
      items.push(u(type, sha, `S-${items.length}`));
    }
    // Independent reference order: compare UTF-8 bytes of type, then of the hash.
    const bytesOf = (s: string) => [...new TextEncoder().encode(s)];
    const cmp = (a: number[], b: number[]) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
      return a.length - b.length;
    };
    const expected = [...items].sort((a, b) => cmp(bytesOf(a.type), bytesOf(b.type)) || cmp(bytesOf(a.contentSha256), bytesOf(b.contentSha256))).map((x) => x.sourceId);
    const reference = canonicalEvidenceManifest(buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items }));
    for (let p = 0; p < 25; p++) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const m = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: shuffled });
      expect(m.items.map((x) => x.sourceId)).toEqual(expected);
      expect(canonicalEvidenceManifest(m)).toBe(reference);
    }
  });

  it("does not let the caller's objects change a built manifest", () => {
    const mutable = { ...a };
    const m = buildEvidenceManifest({ cycleId: "c", cycleVersion: 1, items: [mutable] });
    const before = canonicalEvidenceManifest(m);
    mutable.sourceId = "changed";
    expect(canonicalEvidenceManifest(m)).toBe(before);
  });
});

describe("RFC 3339 boundaries", () => {
  const at = (issuedAt: string) => evidenceItemProblems({ ...a, issuedAt });
  it("accepts real leap days, including year 0000 and 2000, and offsets up to ±23:59", () => {
    for (const t of ["2024-02-29T00:00:00Z", "2000-02-29T12:00:00Z", "0000-02-29T00:00:00Z", "2400-02-29T00:00:00Z", "2026-12-31T23:59:59.999999999Z", "2026-01-01T00:00:00+23:59", "2026-01-01T00:00:00-23:59"])
      expect(at(t), t).toEqual([]);
  });
  it("refuses impossible leap days, months, times and offsets", () => {
    for (const t of ["2023-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-00-10T00:00:00Z", "2026-06-31T00:00:00Z", "2026-01-01T23:60:00Z", "2026-12-31T23:59:60Z", "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+05:60"])
      expect(at(t), t).toHaveLength(1);
  });
  it("accepts an instant in a local daylight-saving gap: the explicit offset makes it unambiguous", () => {
    // 02:30 does not exist on 2026-03-08 in New York, but 02:30-05:00 is a well-defined instant.
    expect(at("2026-03-08T02:30:00-05:00")).toEqual([]);
  });
  it("accepts only uppercase T and Z, and refuses a missing offset or seconds", () => {
    for (const t of ["2026-01-01t00:00:00Z", "2026-01-01T00:00:00z", "2026-01-01 00:00:00Z", "2026-01-01T00:00Z", "2026-01-01T00:00:00+0330"]) expect(at(t), t).toHaveLength(1);
  });
});
