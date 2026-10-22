/**
 * R1 (security review 2026-10-22): a simulation cycle may not carry a mainnet network label. Refused with the body,
 * before authentication and before any query (the pool here fails every query).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SIMULATION_CYCLE_NETWORKS, simulationCycleNetworkRefusal } from "./routes/yield";
import { buildTestApp, tokenFor, unreachablePool } from "./test/helpers";

const TENANT = "00000000-0000-4000-8000-000000000001";
const body = (network: string) => ({
  businessAssetId: "00000000-0000-4000-8000-000000000002",
  periodStart: "2026-01-01",
  periodEnd: "2026-03-31",
  network,
  rail: "SOLANA_TOKEN_2022",
  chainAssetId: "So11111111111111111111111111111111111111112",
});

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("R1: simulation cycle network labels", () => {
  it("allows devnet only while every cycle is a simulation", () => {
    expect(SIMULATION_CYCLE_NETWORKS).toEqual(["solana-devnet"]);
    expect(simulationCycleNetworkRefusal("solana-devnet")).toBeNull();
    const r = simulationCycleNetworkRefusal("solana-mainnet");
    expect(r?.statusCode).toBe(409);
    expect(r?.code).toBe("simulation_network_label");
  });

  it("refuses a mainnet label with 409 simulation_network_label before any query", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { YIELD_WORKFLOW_ENABLED: "true" } }));
    const authorization = `Bearer ${await tokenFor("dev-user")}`;
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${TENANT}/yield/cycles`, headers: { authorization }, payload: body("solana-mainnet") });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("simulation_network_label");
    // Also when the caller asks for a real cycle: the label is refused first, so nothing about it is accepted.
    const real = await app.inject({ method: "POST", url: `/v1/tenants/${TENANT}/yield/cycles`, headers: { authorization }, payload: { ...body("solana-mainnet"), simulation: false } });
    expect(real.json().error).toBe("simulation_network_label");
  });

  it("lets a devnet label through to the usual checks (here: authentication)", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { YIELD_WORKFLOW_ENABLED: "true" } }));
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${TENANT}/yield/cycles`, payload: body("solana-devnet") });
    expect(r.statusCode).toBe(401);
  });

  it("is still a 404 when the workflow is off", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${TENANT}/yield/cycles`, payload: body("solana-mainnet") });
    expect(r.statusCode).toBe(404);
  });

  it("still validates the body first (an unknown network is a 400, not the R1 refusal)", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { YIELD_WORKFLOW_ENABLED: "true" } }));
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${TENANT}/yield/cycles`, payload: body("tron-mainnet") });
    expect(r.statusCode).toBe(400);
  });
});
