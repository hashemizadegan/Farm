/**
 * Test support: a calculation record whose frozen "artifact" is a small canonical text, so its set hash is that
 * text's SHA-256 (migration 0027 checks it), with the genesis carry (no predecessor, empty ledgers; 0028).
 */
import { createHash } from "node:crypto";

export const EMPTY_LEDGER = '{"carriedRemainder":"0","deferred":[]}';
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** A frozen artifact body for `tag`, and its hash (use it as the set hash). */
export function testArtifact(tag: string): { body: string; setHash: string } {
  const body = JSON.stringify({ scheme: "test-artifact/1", tag });
  return { body, setHash: sha256(body) };
}

export function genesisCarry() {
  return { sourceSetId: null, ledgerIn: { body: EMPTY_LEDGER, sha256: sha256(EMPTY_LEDGER) }, ledgerOut: { body: EMPTY_LEDGER, sha256: sha256(EMPTY_LEDGER) } };
}

/** The frozen part of a calculation record with no leaves. */
export function frozenNoLeaves(tag: string) {
  const a = testArtifact(tag);
  return { setHash: a.setHash, frozen: { scheme: "test-artifact/1", body: a.body, hasherId: "test", leaves: [] }, carry: genesisCarry() };
}
