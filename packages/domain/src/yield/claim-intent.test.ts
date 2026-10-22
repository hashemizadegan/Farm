import { describe, expect, it } from "vitest";
import { canonicalYieldArtifact } from "./artifact";
import { CLAIM_INTENT_BATCH_SCHEME, ClaimIntentError, buildClaimIntentBatch, type StoredLeafForIntent } from "./claim-intent";

const h = (n: number) => n.toString(16).padStart(64, "0");
const leaf = (i: number, amount = 10n): StoredLeafForIntent => ({ leafIndex: i, treeSize: 2, leafHash: h(i + 1), leafBytes: "ab".repeat(233), path: [h(9 - i)], hasherId: "sha256-rfc9162", partyId: `p${i}`, recipient: h(20 + i), payoutWallet: `wallet-${i}`.padEnd(32, "x"), amount });
const input = (leaves = [leaf(0), leaf(1, 20n)]) => ({ network: "simulation", cycleId: "00000000-0000-4000-8000-0000000000c1", cycleVersion: 1, setNumber: 2, artifactSetHash: h(5), merkleRoot: h(4), createdAt: "2026-10-22T10:00:00.000Z", payoutMint: "So11111111111111111111111111111111111111112", economicAssetId: "mint", leaves });

describe("unsigned simulation claim intents", () => {
  it("is canonical and deterministic: one stored set, one batch, byte for byte, whatever the leaf order", async () => {
    const a = await buildClaimIntentBatch(input());
    const b = await buildClaimIntentBatch(input([leaf(1, 20n), leaf(0)]));
    expect(b.canonical).toBe(a.canonical);
    expect(b.sha256).toBe(a.sha256);
    expect(canonicalYieldArtifact(a.batch)).toBe(a.canonical);
    expect(a.batch).toMatchObject({ scheme: CLAIM_INTENT_BATCH_SCHEME, signed: false, simulation: true, setNumber: 2, artifactSetHash: h(5), treeSize: 2 });
    expect(a.batch.intents.map((x) => [x.leafIndex, x.amount, x.signed, x.artifactSetHash, x.proof.pathSha256.length])).toEqual([
      [0, 10n, false, h(5), 64],
      [1, 20n, false, h(5), 64],
    ]);
    // Any change of a bound field changes the hash.
    expect((await buildClaimIntentBatch({ ...input(), artifactSetHash: h(6) })).sha256).not.toBe(a.sha256);
    expect((await buildClaimIntentBatch({ ...input(), setNumber: 3 })).sha256).not.toBe(a.sha256);
  });

  it("refuses an empty, gapped, inconsistent or zero-amount set of leaves", async () => {
    const code = async (p: Promise<unknown>) => p.then(() => "no error", (e) => (e instanceof ClaimIntentError ? e.code : String(e)));
    expect(await code(buildClaimIntentBatch(input([])))).toBe("invalid_input");
    expect(await code(buildClaimIntentBatch(input([leaf(0), { ...leaf(1), leafIndex: 2 }])))).toBe("invalid_input");
    expect(await code(buildClaimIntentBatch(input([leaf(0), { ...leaf(1), treeSize: 3 }])))).toBe("invalid_input");
    expect(await code(buildClaimIntentBatch(input([leaf(0, 0n), leaf(1)])))).toBe("invalid_input");
    expect(await code(buildClaimIntentBatch({ ...input(), merkleRoot: "x" }))).toBe("invalid_input");
  });
});
