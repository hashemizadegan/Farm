/**
 * Ownership ingestion interface (simulation only). An `IOwnershipSourceAdapter` turns a snapshot request into
 * a `VerifiedOwnershipSnapshot`. A future chain-backed adapter (plan Y0/Y5, blocked on D-16, D-12, D-17)
 * would implement the same interface; none exists here, and nothing in this module reads a chain, an
 * indexer, an RPC endpoint, a file system or the network.
 *
 * Two adapters, both strictly for simulation testing:
 * - `MockOwnershipAdapter`: deterministic synthetic datasets (`ownership-synthetic.ts`);
 * - `FileFixtureOwnershipAdapter`: a JSON fixture document whose bytes the caller supplies through an
 *   injected reader, optionally pinned to a SHA-256 of those bytes.
 *
 * `loadVerifiedOwnershipSnapshot` is the only way callers should use an adapter. It fails closed:
 * - a request naming anything but a simulation network is refused before the adapter is called;
 * - only adapters that declare `simulationOnly: true` are accepted;
 * - the returned snapshot is re-checked (`ownershipSnapshotProblems`: hash, totals, share bases, order,
 *   network) and must answer the request: same asset, network, reference and verification time.
 *
 * What it cannot guarantee: that a self-consistent snapshot reflects real ownership. A snapshot is only as
 * trustworthy as its source; that is what Y0/Y5 are for.
 */
import { U64_MAX, assertExactKeys } from "./amounts";
import { contentHash } from "../twin/commitments";
import { decodeKey32 } from "./claim-tree";
import {
  OwnershipSnapshotError,
  SIMULATION_NETWORK_IDS,
  SNAPSHOT_REFERENCE_KINDS,
  type OwnershipSnapshotInput,
  type VerifiedOwnershipSnapshot,
  ownershipSnapshotProblems,
  verifyAndNormalizeSnapshot,
} from "./ownership-snapshot";
import { type SyntheticShareProfile, generateSyntheticOwnership } from "./ownership-synthetic";

export interface OwnershipSnapshotRequest {
  /** The economic asset: base58 or 64 hex, 32 bytes. */
  assetId: string;
  /** Must be a simulation network identifier. */
  networkId: string;
  /** The point in history the snapshot must describe. */
  reference: { kind: (typeof SNAPSHOT_REFERENCE_KINDS)[number]; value: bigint };
  /** Supplied by the caller (no clock is read). */
  verifiedAt: string;
}

/** A source of verified ownership snapshots. */
export interface IOwnershipSourceAdapter {
  /** A stable identifier of the adapter and its version, for the record. */
  readonly adapterId: string;
  /** Only `true` is accepted: no adapter for real networks exists or is accepted yet. */
  readonly simulationOnly: true;
  loadSnapshot(request: OwnershipSnapshotRequest): Promise<VerifiedOwnershipSnapshot>;
}

export type OwnershipSourceErrorCode = "invalid_request" | "real_network" | "not_simulation_adapter" | "invalid_fixture" | "fixture_hash_mismatch" | "snapshot_invalid" | "snapshot_mismatch";

export class OwnershipSourceError extends Error {
  constructor(
    readonly code: OwnershipSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnershipSourceError";
  }
}

const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fail = (code: OwnershipSourceErrorCode, message: string): never => {
  throw new OwnershipSourceError(code, message);
};

/** Validates a request; refuses any network that is not a simulation network. Returns the asset's hex. */
export function assertOwnershipSnapshotRequest(request: OwnershipSnapshotRequest): string {
  try {
    assertExactKeys("ownership snapshot request", request, ["assetId", "networkId", "reference", "verifiedAt"]);
    assertExactKeys("request reference", request.reference as unknown, ["kind", "value"]);
  } catch (e) {
    fail("invalid_request", (e as Error).message);
  }
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(request.networkId))
    fail("real_network", `network ${String(request.networkId)} is not a simulation network (${SIMULATION_NETWORK_IDS.join(", ")}); real networks are refused`);
  if (!(SNAPSHOT_REFERENCE_KINDS as readonly unknown[]).includes(request.reference.kind)) fail("invalid_request", `reference.kind must be one of ${SNAPSHOT_REFERENCE_KINDS.join(", ")}`);
  if (typeof request.reference.value !== "bigint" || request.reference.value < 0n || request.reference.value > U64_MAX) fail("invalid_request", "reference.value must be a u64 bigint");
  if (typeof request.verifiedAt !== "string") fail("invalid_request", "verifiedAt must be an RFC 3339 string");
  try {
    return hexOf(decodeKey32("assetId", request.assetId));
  } catch (e) {
    return fail("invalid_request", (e as Error).message);
  }
}

/**
 * Loads a snapshot through an adapter and checks it, failing closed. This is the entry point callers use;
 * the result is what the cycle pipeline takes as `ownership`.
 */
export async function loadVerifiedOwnershipSnapshot(adapter: IOwnershipSourceAdapter, request: OwnershipSnapshotRequest): Promise<VerifiedOwnershipSnapshot> {
  const assetHex = assertOwnershipSnapshotRequest(request);
  if (!adapter || adapter.simulationOnly !== true) fail("not_simulation_adapter", "only adapters declaring simulationOnly: true are accepted");
  if (typeof adapter.adapterId !== "string" || adapter.adapterId === "") fail("not_simulation_adapter", "the adapter must name itself (adapterId)");
  const snapshot = await adapter.loadSnapshot(request);
  const problems = await ownershipSnapshotProblems(snapshot);
  if (problems.length) fail("snapshot_invalid", `adapter ${adapter.adapterId} returned a snapshot that does not verify: ${problems.join("; ")}`);
  if (!Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.entries)) fail("snapshot_invalid", `adapter ${adapter.adapterId} returned a snapshot that is not frozen`);
  const mismatch: string[] = [];
  if (snapshot.assetId !== assetHex) mismatch.push("asset");
  if (snapshot.networkId !== request.networkId) mismatch.push("network");
  if (snapshot.reference.kind !== request.reference.kind || snapshot.reference.value !== request.reference.value) mismatch.push("reference");
  if (snapshot.verifiedAt !== request.verifiedAt) mismatch.push("verification time");
  if (mismatch.length) fail("snapshot_mismatch", `adapter ${adapter.adapterId} returned a snapshot that does not answer the request: ${mismatch.join(", ")} differ`);
  return snapshot;
}

// ── Mock adapter: deterministic synthetic datasets ────────────────────────────────────────────────

export interface MockOwnershipAdapterConfig {
  seed: bigint;
  holders: number;
  profile: SyntheticShareProfile;
  withheldEvery: number;
  unattributed: number;
  /** When the reference was observed (RFC 3339 with an offset); the mock reads no chain. */
  observedAt: string;
}

/** Deterministic synthetic ownership for simulation and stress tests. Same config and request, same snapshot. */
export class MockOwnershipAdapter implements IOwnershipSourceAdapter {
  readonly adapterId = "metafarm-mock-ownership/1";
  readonly simulationOnly = true as const;
  readonly #config: Readonly<MockOwnershipAdapterConfig>;

  constructor(config: MockOwnershipAdapterConfig) {
    assertExactKeys("mock ownership adapter config", config, ["seed", "holders", "profile", "withheldEvery", "unattributed", "observedAt"]);
    this.#config = Object.freeze({ ...config });
    Object.freeze(this);
  }

  /** The canonical input the mock would verify for a request (useful for fixtures and inspection). */
  inputFor(request: OwnershipSnapshotRequest): OwnershipSnapshotInput {
    assertOwnershipSnapshotRequest(request);
    const c = this.#config;
    return generateSyntheticOwnership({
      seed: c.seed,
      holders: c.holders,
      profile: c.profile,
      withheldEvery: c.withheldEvery,
      unattributed: c.unattributed,
      assetId: request.assetId,
      networkId: request.networkId,
      reference: { kind: request.reference.kind, value: request.reference.value, observedAt: c.observedAt },
    });
  }

  async loadSnapshot(request: OwnershipSnapshotRequest): Promise<VerifiedOwnershipSnapshot> {
    return verifyAndNormalizeSnapshot(this.inputFor(request), { verifiedAt: request.verifiedAt });
  }
}

// ── File fixture adapter ───────────────────────────────────────────────────────────────────────

export const OWNERSHIP_FIXTURE_SCHEME = "metafarm-yield-ownership-fixture/1";

/**
 * A fixture document (JSON). Integers are decimal strings (no sign, no leading zeros), so u64 values survive
 * JSON. `simulation` must be `true`.
 */
export interface OwnershipFixtureDocument {
  scheme: typeof OWNERSHIP_FIXTURE_SCHEME;
  simulation: true;
  snapshot: {
    snapshotId: string;
    assetId: string;
    networkId: string;
    reference: { kind: string; value: string; observedAt: string };
    entries: { partyId: string; payoutAddress: string | null; rawShares: string; metadata?: Record<string, string> }[];
    unattributed: { holderKey: string; rawShares: string }[];
  };
}

/** Supplies the fixture's bytes. The domain reads no files: the caller injects the reader. */
export type OwnershipFixtureReader = () => Promise<Uint8Array | string>;

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function decimal(name: string, v: unknown): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v) || v.length > 20) return fail("invalid_fixture", `${name} must be a decimal string without sign or leading zeros`);
  return BigInt(v);
}

/** Parses a fixture document into a snapshot input, strictly (exact keys, decimal-string integers). */
export function parseOwnershipFixture(text: string): OwnershipSnapshotInput {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return fail("invalid_fixture", `the fixture is not JSON: ${(e as Error).message}`);
  }
  try {
    if (!isPlain(doc)) throw new Error("the fixture must be a JSON object");
    assertExactKeys("fixture", doc, ["scheme", "simulation", "snapshot"]);
    if (doc.scheme !== OWNERSHIP_FIXTURE_SCHEME) throw new Error(`fixture scheme must be ${OWNERSHIP_FIXTURE_SCHEME}`);
    if (doc.simulation !== true) throw new Error("the fixture must declare simulation: true");
    const s = doc.snapshot;
    if (!isPlain(s)) throw new Error("fixture snapshot must be an object");
    assertExactKeys("fixture snapshot", s, ["snapshotId", "assetId", "networkId", "reference", "entries", "unattributed"]);
    if (!isPlain(s.reference)) throw new Error("fixture reference must be an object");
    assertExactKeys("fixture reference", s.reference, ["kind", "value", "observedAt"]);
    if (!Array.isArray(s.entries) || !Array.isArray(s.unattributed)) throw new Error("fixture entries and unattributed must be lists");
    for (const [i, e] of (s.entries as unknown[]).entries()) {
      if (!isPlain(e)) throw new Error(`fixture entries[${i}] must be an object`);
      assertExactKeys(`fixture entries[${i}]`, e, ["partyId", "payoutAddress", "rawShares", "metadata"]);
    }
    for (const [i, u] of (s.unattributed as unknown[]).entries()) {
      if (!isPlain(u)) throw new Error(`fixture unattributed[${i}] must be an object`);
      assertExactKeys(`fixture unattributed[${i}]`, u, ["holderKey", "rawShares"]);
    }
  } catch (e) {
    if (e instanceof OwnershipSourceError) throw e;
    fail("invalid_fixture", (e as Error).message);
  }
  const s = (doc as OwnershipFixtureDocument).snapshot;
  return {
    snapshotId: s.snapshotId,
    assetId: s.assetId,
    networkId: s.networkId,
    reference: { kind: s.reference.kind as OwnershipSnapshotInput["reference"]["kind"], value: decimal("reference.value", s.reference.value), observedAt: s.reference.observedAt },
    entries: s.entries.map((e, i) => ({
      partyId: e.partyId,
      payoutAddress: e.payoutAddress,
      rawShares: decimal(`entries[${i}].rawShares`, e.rawShares),
      ...(e.metadata === undefined ? {} : { metadata: e.metadata }),
    })),
    unattributed: s.unattributed.map((u, i) => ({ holderKey: u.holderKey, rawShares: decimal(`unattributed[${i}].rawShares`, u.rawShares) })),
  };
}

/** Serialises a snapshot input as a fixture document (stable key order, two-space indent, trailing newline). */
export function serializeOwnershipFixture(input: OwnershipSnapshotInput): string {
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(input.networkId)) throw new OwnershipSnapshotError("real_network", "fixtures name simulation networks only");
  const doc: OwnershipFixtureDocument = {
    scheme: OWNERSHIP_FIXTURE_SCHEME,
    simulation: true,
    snapshot: {
      snapshotId: input.snapshotId,
      assetId: input.assetId,
      networkId: input.networkId,
      reference: { kind: input.reference.kind, value: input.reference.value.toString(), observedAt: input.reference.observedAt },
      entries: input.entries.map((e) => ({ partyId: e.partyId, payoutAddress: e.payoutAddress, rawShares: e.rawShares.toString(), ...(e.metadata === undefined ? {} : { metadata: e.metadata }) })),
      unattributed: input.unattributed.map((u) => ({ holderKey: u.holderKey, rawShares: u.rawShares.toString() })),
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface FileFixtureOwnershipAdapterConfig {
  read: OwnershipFixtureReader;
  /** If given, the fixture's bytes must hash (SHA-256, hex) to exactly this. */
  expectedSha256: string | null;
}

/** Serves one fixture snapshot for simulation tests. The fixture must answer the request exactly. */
export class FileFixtureOwnershipAdapter implements IOwnershipSourceAdapter {
  readonly adapterId = "metafarm-file-fixture-ownership/1";
  readonly simulationOnly = true as const;
  readonly #config: Readonly<FileFixtureOwnershipAdapterConfig>;

  constructor(config: FileFixtureOwnershipAdapterConfig) {
    assertExactKeys("file fixture adapter config", config, ["read", "expectedSha256"]);
    if (typeof config.read !== "function") throw new OwnershipSourceError("invalid_request", "read must be a function");
    if (config.expectedSha256 !== null && !/^[0-9a-f]{64}$/.test(config.expectedSha256)) throw new OwnershipSourceError("invalid_request", "expectedSha256 must be 64 lowercase hex or null");
    this.#config = Object.freeze({ ...config });
    Object.freeze(this);
  }

  async loadSnapshot(request: OwnershipSnapshotRequest): Promise<VerifiedOwnershipSnapshot> {
    assertOwnershipSnapshotRequest(request);
    const raw = await this.#config.read();
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    if (!(bytes instanceof Uint8Array)) return fail("invalid_fixture", "the reader must return bytes or a string");
    if (this.#config.expectedSha256 !== null) {
      const actual = await contentHash(bytes);
      if (actual !== this.#config.expectedSha256) fail("fixture_hash_mismatch", `the fixture hashes to ${actual}, not the pinned ${this.#config.expectedSha256}`);
    }
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("invalid_fixture", "the fixture is not valid UTF-8");
    }
    return verifyAndNormalizeSnapshot(parseOwnershipFixture(text), { verifiedAt: request.verifiedAt });
  }
}
