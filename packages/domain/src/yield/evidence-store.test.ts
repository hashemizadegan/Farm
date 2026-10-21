import { describe, expect, it } from "vitest";
import { createMemoryContentStore } from "../twin/content-store";
import { type EvidenceItem, evidenceManifestHash } from "./evidence";
import {
  type EvidenceLedger,
  type EvidenceStoreError,
  SIMULATION_EVIDENCE_STORAGE_POLICY,
  assertEvidenceLedger,
  commitEvidence,
  emptyEvidenceLedger,
  evidenceItemsFor,
  evidenceStoragePolicyProblems,
  isAppendOnlyExtension,
  isEvidenceCommitted,
  readEvidenceBytes,
  registerEvidence,
  storeEvidenceBytes,
} from "./evidence-store";
import { YieldRecordError } from "./records";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = async (b: Uint8Array) => [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const cycle = { id: "sim-cycle-1", version: 1, simulation: true };
const policy = SIMULATION_EVIDENCE_STORAGE_POLICY;

async function item(text: string, sourceId: string, patch: Partial<EvidenceItem> = {}): Promise<{ item: EvidenceItem; bytes: Uint8Array }> {
  const bytes = enc(text);
  return {
    bytes,
    item: {
      type: "sales_invoice",
      contentSha256: await sha(bytes),
      byteSize: bytes.length,
      mediaType: "application/pdf",
      issuedAt: "2026-09-30T10:00:00+03:30",
      timeZone: "Asia/Tehran",
      sourceId,
      recordedBy: "user-1",
      recordedAt: "2026-10-01T08:00:00Z",
      classification: "confidential",
      retentionClassId: "simulation-retention",
      supersedes: null,
      ...patch,
    },
  };
}
const reg = (ledger: EvidenceLedger, i: EvidenceItem, c: typeof cycle = cycle, p = policy) => registerEvidence(ledger, { cycle: c, policy: p, item: i, storageRef: `sha256:${i.contentSha256}` });
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as EvidenceStoreError).code ?? (e as Error).name;
  }
  return "no error";
};

describe("evidence ledger: append-only and immutable", () => {
  it("registers, commits, and reproduces the Y3 manifest hash", async () => {
    const a = await item("invoice-1", "INV-1");
    const b = await item("invoice-2", "INV-2");
    let ledger = reg(reg(emptyEvidenceLedger(), a.item), b.item);
    expect(evidenceItemsFor(ledger, cycle.id, 1).map((x) => x.sourceId).sort()).toEqual(["INV-1", "INV-2"]);
    const c = await commitEvidence(ledger, cycle);
    ledger = c.ledger;
    expect(c.manifestSha256).toBe(await evidenceManifestHash(c.manifest));
    expect(ledger.entries.map((e) => [e.seq, e.kind])).toEqual([
      [1, "registered"],
      [2, "registered"],
      [3, "committed"],
    ]);
    expect(isEvidenceCommitted(ledger, cycle.id, 1)).toBe(true);
    await expect(assertEvidenceLedger(ledger)).resolves.toBeUndefined();
  });

  it("only ever appends: each operation extends the previous ledger without changing it", async () => {
    const l0 = emptyEvidenceLedger();
    const l1 = reg(l0, (await item("a", "A")).item);
    const l2 = reg(l1, (await item("b", "B")).item);
    const l3 = (await commitEvidence(l2, cycle)).ledger;
    for (const [p, n] of [[l0, l1], [l1, l2], [l2, l3], [l0, l3]] as const) expect(isAppendOnlyExtension(p, n)).toBe(true);
    expect(isAppendOnlyExtension(l3, l2)).toBe(false);
    expect(l1.entries).toHaveLength(1);
    expect(l2.entries).toHaveLength(2);
  });

  it("is deeply frozen: committed evidence cannot be edited in place", async () => {
    const l = reg(emptyEvidenceLedger(), (await item("a", "A")).item);
    const entry = l.entries[0] as Extract<EvidenceLedger["entries"][number], { kind: "registered" }>;
    expect(Object.isFrozen(l) && Object.isFrozen(l.entries) && Object.isFrozen(entry) && Object.isFrozen(entry.item)).toBe(true);
    expect(() => {
      (entry.item as { sourceId: string }).sourceId = "changed";
    }).toThrow(TypeError);
    expect(() => (l.entries as EvidenceLedger["entries"][number][]).pop()).toThrow(TypeError);
  });

  it("does not let the caller's item object change a registered entry", async () => {
    const a = await item("a", "A");
    const l = reg(emptyEvidenceLedger(), a.item);
    a.item.sourceId = "mutated";
    expect(evidenceItemsFor(l, cycle.id, 1)[0]!.sourceId).toBe("A");
  });

  it("makes re-registering an identical item a no-op, and a changed one a conflict", async () => {
    const a = await item("a", "A");
    const l = reg(emptyEvidenceLedger(), a.item);
    expect(reg(l, { ...a.item })).toBe(l);
    // Same keys in another order are still identical.
    const reordered = Object.fromEntries(Object.entries(a.item).reverse()) as unknown as EvidenceItem;
    expect(reg(l, reordered)).toBe(l);
    expect(await code(() => reg(l, { ...a.item, sourceId: "A-2" }))).toBe("conflict");
  });

  it("freezes a cycle version at commitment: no more evidence, no second commitment", async () => {
    const committed = (await commitEvidence(reg(emptyEvidenceLedger(), (await item("a", "A")).item), cycle)).ledger;
    expect(await code(async () => reg(committed, (await item("b", "B")).item))).toBe("committed");
    expect(await code(() => commitEvidence(committed, cycle))).toBe("committed");
    // A new cycle version is open.
    const v2 = reg(committed, (await item("b", "B")).item, { ...cycle, version: 2 });
    expect(evidenceItemsFor(v2, cycle.id, 2)).toHaveLength(1);
  });

  it("records corrections as superseding items, refusing unknown targets and forks", async () => {
    const a = await item("a", "A");
    const l = reg(emptyEvidenceLedger(), a.item);
    const fix = await item("a-corrected", "A", { supersedes: a.item.contentSha256 });
    const l2 = reg(l, fix.item);
    expect(evidenceItemsFor(l2, cycle.id, 1)).toHaveLength(2);
    const fork = await item("a-other", "A", { supersedes: a.item.contentSha256 });
    expect(await code(() => reg(l2, fork.item))).toBe("supersession");
    const orphan = await item("x", "X", { supersedes: "f".repeat(64) });
    expect(await code(() => reg(l, orphan.item))).toBe("supersession");
  });
});

describe("evidence ledger: D-24 fail-closed and storage references", () => {
  it("refuses real evidence until an approved storage policy exists", async () => {
    const a = await item("a", "A");
    expect(await code(() => reg(emptyEvidenceLedger(), a.item, { ...cycle, simulation: false }))).toBe("YieldRecordError");
    expect(() => reg(emptyEvidenceLedger(), a.item, cycle, { ...policy, status: "draft" })).toThrow(YieldRecordError);
    expect(() => reg(emptyEvidenceLedger(), a.item, { ...cycle, simulation: false }, { ...policy, status: "approved", storageKind: "private_object_storage" })).not.toThrow();
  });

  it("refuses retention classes outside the policy and public storage kinds", async () => {
    const a = await item("a", "A", { retentionClassId: "seven-years" });
    expect(await code(() => reg(emptyEvidenceLedger(), a.item))).toBe("retention_class");
    expect(evidenceStoragePolicyProblems({ ...policy, storageKind: "ipfs" })).toHaveLength(1);
    expect(evidenceStoragePolicyProblems({ ...policy, storageKind: "arweave" })).toHaveLength(1);
    expect(evidenceStoragePolicyProblems({})).toHaveLength(5);
    expect(evidenceStoragePolicyProblems({ ...policy, retentionClassIds: [] })).toHaveLength(1);
    expect(evidenceStoragePolicyProblems({ ...policy, pin: true })).toHaveLength(1);
  });

  it("accepts only content-addressed references the storage kind allows", async () => {
    const a = await item("a", "A");
    const r = (storageRef: string, p = policy) => registerEvidence(emptyEvidenceLedger(), { cycle, policy: p, item: a.item, storageRef });
    expect(await code(() => r(`sha256:${"0".repeat(64)}`))).toBe("storage_ref");
    expect(await code(() => r(`s3://evidence-bucket/yield/${a.item.contentSha256}.pdf`))).toBe("storage_ref"); // in-memory policy
    const privatePolicy = { ...policy, storageKind: "private_object_storage" as const };
    expect(() => r(`s3://evidence-bucket/yield/${a.item.contentSha256}.pdf`, privatePolicy)).not.toThrow();
    expect(await code(() => r(`s3://evidence-bucket/yield/not-the-hash.pdf`, privatePolicy))).toBe("storage_ref");
    expect(await code(() => r(`ipfs://Qm${"a".repeat(44)}`, privatePolicy))).toBe("storage_ref");
    expect(await code(() => r("https://example.com/a.pdf", privatePolicy))).toBe("storage_ref");
  });
});

describe("evidence bytes through the content-store port", () => {
  it("stores and reads back exact bytes, and refuses mismatches and corruption", async () => {
    const store = createMemoryContentStore();
    const a = await item("invoice-bytes", "A");
    const ref = await storeEvidenceBytes(store, a.item, a.bytes);
    expect(ref).toBe(`sha256:${a.item.contentSha256}`);
    expect(new TextDecoder().decode(await readEvidenceBytes(store, a.item))).toBe("invoice-bytes");
    expect(await code(() => storeEvidenceBytes(store, a.item, enc("invoice-bytez")))).toBe("integrity_mismatch");
    const missing = await item("never-stored", "M");
    expect(await code(() => readEvidenceBytes(store, missing.item))).toBe("missing_bytes");
    store.corrupt(a.item.contentSha256, enc("tampered-bytes"));
    expect(await code(() => readEvidenceBytes(store, a.item))).toBe("ContentIntegrityError");
  });
});

describe("ledger verification", () => {
  it("detects reordered sequences, registrations after commitment, double commitment and forged manifest hashes", async () => {
    const a = (await item("a", "A")).item;
    const b = (await item("b", "B")).item;
    const good = (await commitEvidence(reg(emptyEvidenceLedger(), a), cycle)).ledger;
    const [r1, c1] = good.entries;
    const registeredB = { seq: 3, kind: "registered" as const, cycleId: cycle.id, cycleVersion: 1, policyId: policy.id, policyVersion: 1, storageRef: `sha256:${b.contentSha256}`, item: b };
    const cases: EvidenceLedger[] = [
      { entries: [{ ...r1!, seq: 2 }, { ...c1!, seq: 1 }] },
      { entries: [r1!, c1!, registeredB] },
      { entries: [r1!, c1!, { ...c1!, seq: 3 }] },
      { entries: [r1!, { ...(c1 as Extract<typeof c1, { kind: "committed" }>), manifestSha256: "0".repeat(64) }] },
    ];
    for (const l of cases) expect(await code(() => assertEvidenceLedger(l))).toBe("ledger_corrupt");
  });
});
