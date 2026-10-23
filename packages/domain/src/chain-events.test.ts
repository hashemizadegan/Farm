import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHAIN_EVENT_ADAPTERS,
  CHAIN_EVENT_SCHEME,
  ChainEventRefusal,
  assertChainEventNetwork,
  assertWithinDeclaration,
  chainEventAdapterProblems,
  fixtureChainEventAdapter,
  isActionableOwnershipHint,
  relayChainEventAdapter,
  type ChainEventProviderAdapter,
  type NormalizedChainEvent,
} from "./chain-events";
import { FIXTURE_FROM, FIXTURE_MINT, FIXTURE_SIGNATURE, FIXTURE_TO, metadataUpdateData, ownershipChangeData, relayBody } from "./chain-events.fixtures";

const HASH = "cd".repeat(32);
const normalize = (body: unknown) => relayChainEventAdapter.normalize({ provider: "metafarm-relay", body, payloadSha256: HASH });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ChainEventRefusal) return e.code;
    throw e;
  }
  return "accepted";
};

describe("chain events: the canonical relay adapter", () => {
  it("normalizes an ownership change exactly, keeping u64 amounts as strings and the raw reference", () => {
    const [e] = normalize(relayBody("evt-1", ownershipChangeData()));
    expect(e).toEqual<NormalizedChainEvent>({
      scheme: CHAIN_EVENT_SCHEME,
      kind: "ownership_change",
      network: "solana-devnet",
      rail: "SOLANA_TOKEN_2022",
      assetId: FIXTURE_MINT,
      transaction: { signature: FIXTURE_SIGNATURE, slot: "310000900", ixIndex: 2 },
      ownership: { change: "transfer", from: FIXTURE_FROM, to: FIXTURE_TO, amount: "18446744073709551615" },
      metadata: null,
      finality: "finalized",
      providerTimestamp: "2026-10-22T19:00:00.000Z",
      rawReference: { provider: "metafarm-relay", eventId: "evt-1", payloadSha256: HASH },
    });
    expect(isActionableOwnershipHint(e!)).toBe(true);
  });

  it("normalizes a metadata update, which is never an ownership hint", () => {
    const [e] = normalize(relayBody("evt-2", metadataUpdateData()));
    expect(e!.kind).toBe("metadata_update");
    expect(e!.metadata).toEqual({ uri: "https://example.com/meta/1.json", contentSha256: "ab".repeat(32) });
    expect(isActionableOwnershipHint(e!)).toBe(false);
  });

  it("is deterministic: the same body gives the same event", () => {
    expect(normalize(relayBody("evt-1", ownershipChangeData()))).toEqual(normalize(relayBody("evt-1", ownershipChangeData())));
  });

  it("refuses malformed events before anything else", () => {
    const own = (o: Record<string, unknown>) => ownershipChangeData({ ownership: { ...ownershipChangeData().ownership, ...o } });
    const cases: [string, unknown][] = [
      ["not an object", "x"],
      ["unknown top-level field", { ...relayBody("e", ownershipChangeData()), extra: 1 }],
      ["unknown event field", relayBody("e", ownershipChangeData({ hint: "trust me" }))],
      ["bad event id", relayBody("../x", ownershipChangeData())],
      ["type/kind mismatch", { id: "e", type: "chain.metadata_update", data: ownershipChangeData() }],
      ["bad asset id", relayBody("e", ownershipChangeData({ assetId: "0OIl" }))],
      ["bad signature", relayBody("e", ownershipChangeData({ transaction: { signature: "x", slot: "1", ixIndex: 0 } }))],
      ["negative slot", relayBody("e", ownershipChangeData({ transaction: { signature: "5".repeat(88), slot: "-1", ixIndex: 0 } }))],
      ["numeric amount", relayBody("e", own({ amount: 5 }))],
      ["zero amount", relayBody("e", own({ amount: "0" }))],
      ["amount above u64", relayBody("e", own({ amount: "18446744073709551616" }))],
      ["mint with a from", relayBody("e", own({ change: "mint" }))],
      ["burn with a to", relayBody("e", own({ change: "burn" }))],
      ["transfer to itself", relayBody("e", own({ to: FIXTURE_FROM }))],
      ["cNFT amount above 1", relayBody("e", ownershipChangeData({ rail: "SOLANA_BUBBLEGUM_CNFT", ownership: { change: "transfer", from: FIXTURE_FROM, to: FIXTURE_TO, amount: "2" } }))],
      ["ownership change with metadata", relayBody("e", ownershipChangeData({ metadata: { uri: null, contentSha256: "ab".repeat(32) } }))],
      ["metadata over http", relayBody("e", metadataUpdateData({ metadata: { uri: "http://x.example/1", contentSha256: null } }))],
      ["empty metadata", relayBody("e", metadataUpdateData({ metadata: { uri: null, contentSha256: null } }))],
      ["unknown finality", relayBody("e", ownershipChangeData({ finality: "final-ish" }))],
      ["timestamp without zone", relayBody("e", ownershipChangeData({ providerTimestamp: "2026-10-22T19:00:00" }))],
      ["rail on the wrong network", relayBody("e", ownershipChangeData({ network: "tron-nile" }))],
    ];
    for (const [name, body] of cases) expect(code(() => normalize(body)), name).toBe("malformed");
  });

  it("refuses unsupported events and networks with their own codes", () => {
    expect(code(() => normalize({ id: "e", type: "sensor.reading", data: {} }))).toBe("unsupported_event");
    expect(code(() => normalize(relayBody("e", ownershipChangeData({ kind: "stake" }))))).toBe("unsupported_event");
    expect(code(() => normalize(relayBody("e", ownershipChangeData({ network: "ethereum" }))))).toBe("unsupported_network");
    expect(code(() => normalize(relayBody("e", ownershipChangeData({ rail: "TRON_TRC20", network: "tron-nile" }))))).toBe("unsupported_network");
  });

  it("checks the deployment's network", () => {
    const [e] = normalize(relayBody("e", ownershipChangeData()));
    expect(() => assertChainEventNetwork(e!, "solana-devnet")).not.toThrow();
    expect(code(() => assertChainEventNetwork(e!, "solana-mainnet"))).toBe("network_mismatch");
  });

  it("does not act on processed (not yet confirmed) ownership changes", () => {
    const [e] = normalize(relayBody("e", ownershipChangeData({ finality: "processed" })));
    expect(isActionableOwnershipHint(e!)).toBe(false);
  });

  it("ships only the provider-neutral relay and the simulated CI fixture adapter (no vendor mapping)", () => {
    expect(Object.keys(CHAIN_EVENT_ADAPTERS)).toEqual(["metafarm-relay", "metafarm-fixture"]);
    expect(Object.values(CHAIN_EVENT_ADAPTERS).map((a) => [a.id, a.capabilities.simulated])).toEqual([
      ["metafarm-relay", false],
      ["metafarm-fixture", true],
    ]);
  });
});

describe("chain events: the adapter boundary", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/chain-events");
  const fixture = (name: string) => readFileSync(path.join(dir, name), "utf8");
  const viaFixture = (name: string) =>
    assertWithinDeclaration(fixtureChainEventAdapter, fixtureChainEventAdapter.normalize({ provider: "metafarm-fixture", body: JSON.parse(fixture(name)), payloadSha256: HASH }));

  it("every shipped adapter declares a usable configuration (kinds, networks, rails, finality, verification)", () => {
    for (const a of Object.values(CHAIN_EVENT_ADAPTERS)) expect(chainEventAdapterProblems(a), a.id).toEqual([]);
    expect(relayChainEventAdapter.capabilities.verification).toBe("platform-hmac");
    expect(fixtureChainEventAdapter.capabilities.networks).toEqual(["solana-devnet"]);
  });

  it("refuses declarations the contract cannot honour", () => {
    const bad: ChainEventProviderAdapter = {
      ...relayChainEventAdapter,
      id: "Vendor X",
      capabilities: { ...relayChainEventAdapter.capabilities, rails: ["TRON_TRC20"], finality: { reported: ["processed"], minimumForOwnershipHint: "finalized" }, verification: "adapter" },
    };
    expect(chainEventAdapterProblems(bad)).toEqual([
      "id must be lowercase letters, digits and hyphens",
      "rails must be chain-event rails (Solana)",
      "rail TRON_TRC20 has none of its networks declared",
      "the hint threshold must be a reported finality level",
      "adapter verification needs a verify function",
    ]);
  });

  it("maps the fixture wire shape to metafarm-chain-event/1, deterministically", () => {
    const [e] = viaFixture("ownership.json");
    expect(e).toEqual({
      scheme: CHAIN_EVENT_SCHEME,
      kind: "ownership_change",
      network: "solana-devnet",
      rail: "SOLANA_TOKEN_2022",
      assetId: FIXTURE_MINT,
      transaction: { signature: FIXTURE_SIGNATURE, slot: "310000900", ixIndex: 2 },
      ownership: { change: "transfer", from: FIXTURE_FROM, to: FIXTURE_TO, amount: "1000000" },
      metadata: null,
      finality: "finalized",
      providerTimestamp: "2026-10-23T01:00:00.000Z",
      rawReference: { provider: "metafarm-fixture", eventId: "fx-ownership-1", payloadSha256: HASH },
    });
    expect(viaFixture("ownership.json")).toEqual(viaFixture("ownership.json"));
    const [m] = viaFixture("metadata.json");
    expect([m!.kind, m!.ownership, isActionableOwnershipHint(m!)]).toEqual(["metadata_update", null, false]);
  });

  it("duplicate: the same delivery id maps to the same idempotency key", () => {
    expect(viaFixture("duplicate.json")[0]!.rawReference.eventId).toBe(viaFixture("ownership.json")[0]!.rawReference.eventId);
  });

  it("malformed and wrong-network deliveries are refused with stable codes", () => {
    expect(code(() => viaFixture("malformed.json"))).toBe("malformed");
    expect(code(() => viaFixture("wrong-network.json"))).toBe("unsupported_network");
    expect(code(() => fixtureChainEventAdapter.normalize({ provider: "metafarm-fixture", body: { fixture: "vendor/9", deliveryId: "x", events: [] }, payloadSha256: HASH }))).toBe("unsupported_event");
    expect(code(() => fixtureChainEventAdapter.normalize({ provider: "metafarm-fixture", body: { ...JSON.parse(fixture("ownership.json")), tenantId: "x" }, payloadSha256: HASH }))).toBe("malformed");
  });

  it("delayed finality: only the adapter's threshold turns an ownership change into a re-read hint", () => {
    const threshold = fixtureChainEventAdapter.capabilities.finality.minimumForOwnershipHint;
    expect(threshold).toBe("finalized");
    const steps = ["delayed-finality-processed.json", "delayed-finality-confirmed.json", "delayed-finality-finalized.json"].map((f) => viaFixture(f)[0]!);
    expect(steps.map((e) => [e.finality, isActionableOwnershipHint(e, threshold)])).toEqual([
      ["processed", false],
      ["confirmed", false],
      ["finalized", true],
    ]);
    // Same transaction, three deliveries: three idempotency keys, so the final one is not dropped as a duplicate.
    expect(new Set(steps.map((e) => e.transaction.signature + e.transaction.slot)).size).toBe(1);
    expect(new Set(steps.map((e) => e.rawReference.eventId)).size).toBe(3);
  });
});
