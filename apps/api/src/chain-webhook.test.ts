/**
 * Chain event webhooks (provider-neutral): every refusal happens before anything is stored. The pool fails any query;
 * rejection audits are best-effort (caught), so a refused request still answers its stable code.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { metadataUpdateData, ownershipChangeData, relayBody } from "@metafarm/domain/chain-events.fixtures";
import { signWebhook } from "@metafarm/domain/server";
import { buildTestApp, unreachablePool } from "./test/helpers";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

const ENABLED = { CHAIN_EVENT_PROVIDERS: "metafarm-relay" };
const post = (provider: string, body: unknown, secret = "whsec_test") => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: `/v1/webhooks/${provider}`,
    headers: { "content-type": "application/json", "x-webhook-signature": signWebhook(secret, raw, Math.floor(Date.now() / 1000)) },
    payload: raw,
  });
};

describe("chain event webhooks: refusals before persistence", () => {
  it("refuses a chain provider that is not enabled (the default)", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await post("metafarm-relay", relayBody("evt-1", ownershipChangeData()));
    expect([r.statusCode, r.json().error]).toEqual([404, "provider_not_enabled"]);
  });

  it("still checks the signature first", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: ENABLED }));
    expect((await post("metafarm-relay", relayBody("evt-1", ownershipChangeData()), "wrong")).statusCode).toBe(401);
  });

  it("refuses malformed, unsupported and wrong-network events with stable codes", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: ENABLED }));
    const cases: [unknown, string][] = [
      [relayBody("evt-1", ownershipChangeData({ assetId: "nope" })), "chain_event_malformed"],
      [relayBody("evt-1", ownershipChangeData({ ownership: { change: "transfer", from: null, to: null, amount: "1" } })), "chain_event_malformed"],
      [{ id: "evt-1", type: "sensor.reading", data: {} }, "chain_event_unsupported_event"],
      [relayBody("evt-1", ownershipChangeData({ rail: "TRON_TRC20", network: "tron-nile" })), "chain_event_unsupported_network"],
      [relayBody("evt-1", ownershipChangeData({ network: "solana-mainnet" })), "chain_event_network_mismatch"],
    ];
    for (const [body, error] of cases) {
      const r = await post("metafarm-relay", body);
      expect([r.statusCode, r.json().error], error).toEqual([422, error]);
    }
  });

  it("serves the configured network only: a mainnet deployment refuses devnet events", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { ...ENABLED, RWA_SOLANA_NETWORK: "solana-mainnet" } }));
    const r = await post("metafarm-relay", relayBody("evt-2", metadataUpdateData()));
    expect([r.statusCode, r.json().error]).toEqual([422, "chain_event_network_mismatch"]);
  });

  it("refuses to start with a chain provider that has no adapter", async () => {
    await expect(buildTestApp({ pool: unreachablePool(), env: { CHAIN_EVENT_PROVIDERS: "some-vendor" } })).rejects.toThrow(/no chain event adapter/);
  });
});
