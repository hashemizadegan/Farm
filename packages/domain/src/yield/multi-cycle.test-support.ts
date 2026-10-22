/**
 * Multi-cycle simulation harness (test support; simulation only). Runs a chain of consecutive simulation cycles
 * through the real pipeline, carries each cycle's distribution ledger (carried remainder and deferred dust) into
 * the next, projects every published version into one claim read-model store, and models corrections.
 *
 * Harness rules:
 * - **Carry-forward:** cycle k+1 takes, as its `distributionLedger`, exactly the `ledgerOut` of the version of
 *   cycle k it is based on (`basedOn`). Nothing else carries money between cycles.
 * - **Corrections are new versions (latest wins):** correcting cycle k publishes version v+1 of the same cycle id
 *   (a new artifact hash). Every published version stays in the store and can still be opened by version, but
 *   `open(cycleId)` serves the latest.
 * - **Downstream rebase:** a cycle built on a superseded predecessor is stale. `correct` re-derives every later
 *   cycle as a new version built on the corrected history (unless `rebase: false`, used only to test the stale
 *   state). A stale cycle is never served: `open` fails closed.
 *
 * No file, database or network I/O; no clock (all times fixed); no randomness source (seeded synthetic ownership).
 * The pipeline itself refuses non-simulation cycles and real networks.
 */
import { SHA256_RFC9162_HASHER } from "./claim-tree";
import { type ClaimReadModel, InMemoryClaimReadModelStore, openClaimReadModel, projectClaimReadModel } from "./claim-read-model";
import { type DistributionLedger, type DistributionPolicy, SIMULATION_DISTRIBUTION_POLICY, emptyDistributionLedger } from "./distribution";
import type { EvidenceLine } from "./aggregation";
import { MockOwnershipAdapter, loadVerifiedOwnershipSnapshot } from "./ownership-source";
import type { SyntheticShareProfile } from "./ownership-synthetic";
import type { VerifiedOwnershipSnapshot } from "./ownership-snapshot";
import { type CycleDistributionArtifact, calculateSimulationCycle } from "./pipeline";
import { CYCLE, LINES, committedLedger, input } from "./pipeline.scenario.test-support";

export interface ChainCycleSpec {
  cycleId: string;
  /** Seed of this cycle's ownership snapshot (holders keep their ids; shares and addresses vary by seed). */
  ownershipSeed: bigint;
  /** The snapshot's slot. */
  slot: bigint;
  /** Evidence lines of version 1 (defaults to the scenario's lines). */
  evidenceLines?: EvidenceLine[];
}

export interface ChainParams {
  holders: number;
  profile: SyntheticShareProfile;
  /** Must be a simulation-status record (refused otherwise, here and by the pipeline). */
  distributionPolicy: DistributionPolicy;
  cycles: ChainCycleSpec[];
}

export interface PublishedVersion {
  cycleId: string;
  version: number;
  /** The predecessor version this version's carry-forward came from (null for the first cycle). */
  basedOn: { cycleId: string; version: number } | null;
  ledgerIn: DistributionLedger;
  ledgerOut: DistributionLedger;
  ownership: VerifiedOwnershipSnapshot;
  evidenceLines: EvidenceLine[];
  artifact: CycleDistributionArtifact;
  artifactSha256: string;
}

/** The fixed multi-cycle scenario: 3 cycles × 4,096 holders, uniform shares, carry remainder, dust 1,000,000. */
export const CHAIN_DEFAULTS: ChainParams = Object.freeze({
  holders: 4_096,
  profile: "uniform" as const,
  distributionPolicy: Object.freeze({ ...SIMULATION_DISTRIBUTION_POLICY, id: "simulation-multi-cycle", remainder: "carry" as const, dustThreshold: 1_000_000n, missingPayoutWallet: "withhold" as const }),
  cycles: Object.freeze([
    { cycleId: "00000000-0000-4000-8000-0000000c0001", ownershipSeed: 0xc1c1en, slot: 300_000_000n },
    { cycleId: "00000000-0000-4000-8000-0000000c0002", ownershipSeed: 0xc2c2en, slot: 300_500_000n },
    { cycleId: "00000000-0000-4000-8000-0000000c0003", ownershipSeed: 0xc3c3en, slot: 301_000_000n },
  ]) as ChainCycleSpec[],
});

/** Cycle 2's correction: the USD revenue line was under-reported by 500.00 (800,000 → 850,000 minor units). */
export const CYCLE2_CORRECTED_LINES: EvidenceLine[] = LINES.map((l) => (l.lineId === "rev-usd" ? { ...l, amount: 850_000n } : l));

export type ChainServingErrorCode = "unknown_cycle" | "unknown_version" | "stale_cycle" | "version_gap" | "version_not_monotonic" | "invalid_version";

/** A harness refusal with a stable code; messages have a fixed format (see each throw site). */
export class ChainServingError extends Error {
  constructor(
    readonly code: ChainServingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChainServingError";
  }
}

/**
 * The published-versions index: per cycle id, the versions published so far, in order. Strict rule (explicit and
 * deterministic): a cycle's versions are exactly 1, 2, 3, … with no gaps.
 * - The first version of a cycle must be 1; each later one must be latest + 1.
 * - A version above latest + 1 (e.g. v3 without v2) is refused: `version_gap`.
 * - A version at or below the latest (a repeat or an older version) is refused: `version_not_monotonic`.
 * - Nothing is ever removed or replaced, so `latest(id)` only moves forward (monotonic), and every earlier version
 *   stays addressable for audit.
 */
export class PublishedVersionsIndex<T extends { cycleId: string; version: number; artifactSha256: string }> {
  readonly #byCycle = new Map<string, T[]>();

  record(entry: T): T {
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) throw new ChainServingError("invalid_version", `cycle ${entry.cycleId}: version must be an integer >= 1, got ${String(entry.version)}`);
    if (!/^[0-9a-f]{64}$/.test(entry.artifactSha256)) throw new ChainServingError("invalid_version", `cycle ${entry.cycleId} v${entry.version}: artifactSha256 must be 64 lowercase hex`);
    const versions = this.#byCycle.get(entry.cycleId) ?? [];
    const latest = versions.length;
    if (entry.version <= latest) throw new ChainServingError("version_not_monotonic", `cycle ${entry.cycleId}: v${entry.version} is not after the latest published v${latest}`);
    if (entry.version !== latest + 1) throw new ChainServingError("version_gap", `cycle ${entry.cycleId}: v${entry.version} would skip v${latest + 1}`);
    this.#byCycle.set(entry.cycleId, [...versions, Object.freeze(entry)]);
    return entry;
  }

  has(cycleId: string): boolean {
    return this.#byCycle.has(cycleId);
  }

  versions(cycleId: string): T[] {
    return [...(this.#byCycle.get(cycleId) ?? [])];
  }

  latest(cycleId: string): T {
    const v = this.#byCycle.get(cycleId);
    if (!v?.length) throw new ChainServingError("unknown_cycle", `cycle ${cycleId} has not been published`);
    return v[v.length - 1]!;
  }

  version(cycleId: string, version: number): T {
    const v = this.#byCycle.get(cycleId);
    if (!v?.length) throw new ChainServingError("unknown_cycle", `cycle ${cycleId} has not been published`);
    const found = v.find((x) => x.version === version);
    if (!found) throw new ChainServingError("unknown_version", `cycle ${cycleId} has no version ${String(version)}`);
    return found;
  }
}

export class SimulationChain {
  readonly store = new InMemoryClaimReadModelStore();
  readonly #params: ChainParams;
  /** Every published version, through the strict published-versions index. */
  readonly index = new PublishedVersionsIndex<PublishedVersion>();

  constructor(params: ChainParams) {
    if (params.distributionPolicy.status !== "simulation") throw new Error("the multi-cycle harness runs simulation policy records only");
    if (params.cycles.length < 1 || new Set(params.cycles.map((c) => c.cycleId)).size !== params.cycles.length) throw new Error("cycle ids must be unique");
    this.#params = params;
  }

  get cycleIds(): string[] {
    return this.#params.cycles.map((c) => c.cycleId);
  }

  history(cycleId: string): PublishedVersion[] {
    return this.index.versions(cycleId);
  }

  latest(cycleId: string): PublishedVersion {
    return this.index.latest(cycleId);
  }

  /** The latest version of every published cycle, in chain order. */
  latestChain(): PublishedVersion[] {
    return this.cycleIds.filter((id) => this.index.has(id)).map((id) => this.latest(id));
  }

  /** Publishes version 1 of every cycle in order, each based on the latest version of its predecessor. */
  async publishAll(): Promise<PublishedVersion[]> {
    for (let i = 0; i < this.#params.cycles.length; i++) if (!this.index.has(this.cycleIds[i]!)) await this.#publish(i, this.#params.cycles[i]!.evidenceLines ?? LINES);
    return this.latestChain();
  }

  /**
   * Publishes a corrected version of cycle `index` (new evidence lines), then, unless `rebase` is false,
   * re-derives every later published cycle as a new version built on the corrected history.
   */
  async correct(index: number, patch: { evidenceLines: EvidenceLine[] }, options: { rebase: boolean } = { rebase: true }): Promise<PublishedVersion[]> {
    const id = this.cycleIds[index];
    if (id === undefined || !this.index.has(id)) throw new ChainServingError("unknown_cycle", `cycle ${String(id ?? index)} has not been published`);
    await this.#publish(index, patch.evidenceLines);
    if (options.rebase) for (let j = index + 1; j < this.cycleIds.length; j++) if (this.index.has(this.cycleIds[j]!)) await this.#publish(j, this.latest(this.cycleIds[j]!).evidenceLines);
    return this.latestChain();
  }

  /** Problems with the latest chain: a latest version not built on its predecessor's latest version, or a broken carry. */
  chainProblems(): string[] {
    const out: string[] = [];
    const chain = this.latestChain();
    for (let i = 1; i < chain.length; i++) {
      const [prev, cur] = [chain[i - 1]!, chain[i]!];
      if (cur.basedOn?.cycleId !== prev.cycleId || cur.basedOn.version !== prev.version) out.push(`cycle ${cur.cycleId} v${cur.version} is stale: based on ${cur.basedOn?.cycleId} v${cur.basedOn?.version}, latest is v${prev.version}`);
      else if (!sameLedger(cur.ledgerIn, prev.ledgerOut)) out.push(`cycle ${cur.cycleId} v${cur.version} did not take its predecessor's ledger exactly`);
    }
    return out;
  }

  /**
   * Opens the read model of a cycle: the latest version unless a version is given. Fails closed on a stale
   * latest version (built on superseded history).
   */
  async open(cycleId: string, version?: number): Promise<ClaimReadModel> {
    // Explicit versions are audit reads: any published version, stale or superseded. "Latest" is served only
    // when it is built on its predecessor's latest version; otherwise `stale_cycle`, message:
    //   refusing to serve cycle <id> v<n> is stale: based on <pred id> v<m>, latest is v<k>
    const v = version === undefined ? this.index.latest(cycleId) : this.index.version(cycleId, version);
    if (version === undefined) {
      const stale = this.chainProblems().find((p) => p.startsWith(`cycle ${cycleId} `));
      if (stale) throw new ChainServingError("stale_cycle", `refusing to serve ${stale}`);
    }
    return openClaimReadModel(this.store, { cycleId, cycleVersion: v.version, artifactSha256: v.artifactSha256 }, SHA256_RFC9162_HASHER);
  }

  async #publish(index: number, evidenceLines: EvidenceLine[]): Promise<PublishedVersion> {
    const spec = this.#params.cycles[index]!;
    const previous = this.index.versions(spec.cycleId);
    const version = previous.length + 1;
    const predecessor = index === 0 ? null : this.latest(this.cycleIds[index - 1]!);
    const ledgerIn = predecessor ? predecessor.ledgerOut : emptyDistributionLedger();
    const cycle = { ...CYCLE, id: spec.cycleId, version };
    const ownership =
      previous[0]?.ownership ??
      (await loadVerifiedOwnershipSnapshot(
        new MockOwnershipAdapter({ seed: spec.ownershipSeed, holders: this.#params.holders, profile: this.#params.profile, withheldEvery: 61, unattributed: 2, observedAt: "2026-09-30T23:59:59Z" }),
        { assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot", value: spec.slot }, verifiedAt: "2026-10-01T09:00:00Z" },
      ));
    const base = await input();
    const { artifact, artifactSha256 } = await calculateSimulationCycle({
      ...base,
      cycle,
      evidenceLedger: await committedLedger(cycle),
      evidenceLines,
      ownership,
      distributionPolicy: this.#params.distributionPolicy,
      distributionLedger: ledgerIn,
    });
    await projectClaimReadModel(artifact, artifactSha256, SHA256_RFC9162_HASHER, this.store);
    const published: PublishedVersion = {
      cycleId: spec.cycleId,
      version,
      basedOn: predecessor ? { cycleId: predecessor.cycleId, version: predecessor.version } : null,
      ledgerIn,
      ledgerOut: artifact.distribution.plan.ledgerOut,
      ownership,
      evidenceLines,
      artifact,
      artifactSha256,
    };
    return this.index.record(published);
  }
}

const sameLedger = (a: DistributionLedger, b: DistributionLedger) =>
  a.carriedRemainder === b.carriedRemainder && a.deferred.length === b.deferred.length && a.deferred.every((d, i) => d.partyId === b.deferred[i]!.partyId && d.amount === b.deferred[i]!.amount);
