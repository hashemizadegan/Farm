/**
 * The carry-forward ledger between consecutive simulation cycles of one asset: what a cycle's distribution plan
 * carries out (`DistributionPlan.ledgerOut`: the carried remainder and each party's deferred dust) becomes the next
 * cycle's carry-in (`ledgerIn`). Content-addressed: the canonical text and its SHA-256 are what the platform stores
 * and chains (migration 0028); a ledger that does not hash to its recorded value is refused.
 */
import { assertExactKeys } from "./amounts";
import { canonicalYieldArtifact } from "./artifact";
import type { DistributionLedger } from "./distribution";

export const EMPTY_CARRY_LEDGER: DistributionLedger = Object.freeze({ carriedRemainder: 0n, deferred: Object.freeze([]) as unknown as DistributionLedger["deferred"] });

export class CarryLedgerError extends Error {
  constructor(
    readonly code: "invalid_ledger" | "ledger_hash_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "CarryLedgerError";
  }
}

/** Canonical text: `{"carriedRemainder":"<n>","deferred":[{"amount":"<n>","partyId":"<id>"},…]}`, deferred by party id. */
export function canonicalCarryLedger(l: DistributionLedger): string {
  const deferred = [...l.deferred].sort((a, b) => (a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0));
  return canonicalYieldArtifact({ carriedRemainder: l.carriedRemainder, deferred });
}

export async function carryLedgerHash(l: DistributionLedger): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCarryLedger(l));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parses a stored ledger, checks its shape and, when given, that its canonical text hashes to `sha256`. */
export async function parseCarryLedger(text: string, sha256?: string): Promise<DistributionLedger> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CarryLedgerError("invalid_ledger", "the carry ledger is not JSON");
  }
  const bad = (m: string): never => {
    throw new CarryLedgerError("invalid_ledger", m);
  };
  try {
    assertExactKeys("carry ledger", raw, ["carriedRemainder", "deferred"]);
  } catch (e) {
    bad((e as Error).message);
  }
  const o = raw as { carriedRemainder: unknown; deferred: unknown };
  const int = (v: unknown, what: string) => (typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : bad(`${what} must be a non-negative integer string`));
  if (!Array.isArray(o.deferred)) bad("deferred must be a list");
  const seen = new Set<string>();
  const deferred = (o.deferred as unknown[]).map((d, i) => {
    try {
      assertExactKeys(`deferred[${i}]`, d, ["partyId", "amount"]);
    } catch (e) {
      bad((e as Error).message);
    }
    const x = d as { partyId: unknown; amount: unknown };
    if (typeof x.partyId !== "string" || x.partyId === "" || seen.has(x.partyId)) bad(`deferred[${i}] needs a unique party id`);
    seen.add(x.partyId as string);
    return { partyId: x.partyId as string, amount: int(x.amount, `deferred[${i}].amount`) };
  });
  const ledger: DistributionLedger = { carriedRemainder: int(o.carriedRemainder, "carriedRemainder"), deferred };
  if (canonicalCarryLedger(ledger) !== text) bad("the carry ledger is not in canonical form");
  if (sha256 !== undefined && (await carryLedgerHash(ledger)) !== sha256) throw new CarryLedgerError("ledger_hash_mismatch", "the carry ledger does not hash to its recorded value");
  return ledger;
}
