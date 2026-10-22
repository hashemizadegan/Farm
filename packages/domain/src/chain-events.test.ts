import { describe, expect, it } from "vitest";
import {
  CHAIN_EVENT_ADAPTERS,
  CHAIN_EVENT_SCHEME,
  ChainEventRefusal,
  assertChainEventNetwork,
  isActionableOwnershipHint,
  relayChainEventAdapter,
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

  it("ships only the provider-neutral relay adapter", () => {
    expect(Object.keys(CHAIN_EVENT_ADAPTERS)).toEqual(["metafarm-relay"]);
  });
});
