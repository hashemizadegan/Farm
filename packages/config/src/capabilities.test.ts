import { describe, expect, it } from "vitest";
import {
  CapabilityConfigError,
  apiCapabilities,
  assertCapabilities,
  describeCapabilities,
  evmChainCapability,
  identityCapability,
  imageryCapability,
  mapTilesCapability,
  mediaScanningCapability,
  solanaCapability,
  storageCapability,
  telemetryCapability,
  chainEventsCapability,
  webCapabilities,
  workerCapabilities,
} from "./capabilities";

const SECRET = "s3cr3t-value-that-must-never-be-printed";
const dev = { APP_ENV: "development" };
const prod = { APP_ENV: "production" };

describe("provider capabilities: states", () => {
  it("identity: oidc enabled / missing; dev sign-in simulated, refused when deployed", () => {
    expect(identityCapability({ ...prod, AUTH_PROVIDER: "oidc", OIDC_ISSUER_URL: "https://id.example", OIDC_AUDIENCE: "api" })).toMatchObject({ state: "enabled", provider: "oidc", simulated: false });
    expect(identityCapability({ ...prod, AUTH_PROVIDER: "oidc", OIDC_ISSUER_URL: "https://id.example" })).toMatchObject({ state: "missing", missing: ["OIDC_AUDIENCE"] });
    expect(identityCapability({ ...dev, AUTH_PROVIDER: "dev", DEV_AUTH_SECRET: SECRET })).toMatchObject({ state: "enabled", provider: "dev", simulated: true });
    expect(identityCapability({ ...dev })).toMatchObject({ state: "missing", missing: ["DEV_AUTH_SECRET"] });
    expect(identityCapability({ ...prod, DEV_AUTH_SECRET: SECRET })).toMatchObject({ state: "invalid" });
  });

  it("storage: s3 enabled / missing / invalid over http when deployed; memory simulated and refused when deployed", () => {
    const s3 = { STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: SECRET };
    expect(storageCapability({ ...prod, ...s3, S3_ENDPOINT: "https://s3.example" })).toMatchObject({ state: "enabled", provider: "s3" });
    expect(storageCapability({ ...prod, STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toMatchObject({ state: "missing", missing: ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] });
    expect(storageCapability({ ...prod, ...s3, S3_ENDPOINT: "http://minio:9000" })).toMatchObject({ state: "invalid" });
    expect(storageCapability({ ...dev, ...s3, S3_ENDPOINT: "http://localhost:9000" })).toMatchObject({ state: "enabled" });
    expect(storageCapability({ ...dev })).toMatchObject({ state: "enabled", provider: "memory", simulated: true });
    expect(storageCapability({ ...prod, STORAGE_DRIVER: "memory" })).toMatchObject({ state: "invalid" });
  });

  it("imagery: disabled by default (nothing fabricated); mock only outside deployments", () => {
    expect(imageryCapability({ ...prod })).toMatchObject({ state: "disabled", provider: null });
    expect(imageryCapability({ ...dev, IMAGERY_PROVIDER: "mock" })).toMatchObject({ state: "enabled", simulated: true });
    expect(imageryCapability({ ...prod, IMAGERY_PROVIDER: "mock" })).toMatchObject({ state: "invalid" });
  });

  it("EVM chain: disabled without RPC; contracts without RPC are missing it; enabled with RPC", () => {
    expect(evmChainCapability({})).toMatchObject({ state: "disabled" });
    expect(evmChainCapability({ HARVEST_REGISTRY_ADDRESS: "0x" + "1".repeat(40) })).toMatchObject({ state: "missing", missing: ["CHAIN_RPC_URL"] });
    expect(evmChainCapability({ CHAIN_RPC_URL: "https://rpc.example" })).toMatchObject({ state: "enabled" });
  });

  it("Solana: disabled without RPC; DAS without RPC missing; mainnet without the mainnet switch invalid", () => {
    expect(solanaCapability({})).toMatchObject({ state: "disabled" });
    expect(solanaCapability({ RWA_SOLANA_DAS_URL: "https://das.example" })).toMatchObject({ state: "missing", missing: ["RWA_SOLANA_RPC_URL"] });
    expect(solanaCapability({ RWA_SOLANA_RPC_URL: "https://rpc.example", RWA_SOLANA_NETWORK: "solana-devnet" })).toMatchObject({ state: "enabled", provider: "solana-devnet" });
    expect(solanaCapability({ RWA_SOLANA_RPC_URL: "https://rpc.example", RWA_SOLANA_NETWORK: "solana-mainnet", RWA_MAINNET_ENABLED: false })).toMatchObject({ state: "invalid" });
    expect(solanaCapability({ RWA_SOLANA_RPC_URL: "https://rpc.example", RWA_SOLANA_NETWORK: "solana-mainnet", RWA_MAINNET_ENABLED: true })).toMatchObject({ state: "enabled" });
  });

  it("chain events, telemetry and media scanning", () => {
    expect(chainEventsCapability({ CHAIN_EVENT_PROVIDERS: [] })).toMatchObject({ state: "disabled" });
    expect(chainEventsCapability({ CHAIN_EVENT_PROVIDERS: ["metafarm-relay"] })).toMatchObject({ state: "enabled", provider: "metafarm-relay" });
    expect(telemetryCapability({})).toMatchObject({ state: "disabled" });
    expect(telemetryCapability({ MQTT_URL: "mqtts://broker.example" })).toMatchObject({ state: "enabled" });
    // No scanner is integrated: the platform must never claim uploads are scanned.
    expect(mediaScanningCapability()).toMatchObject({ state: "disabled" });
  });

  it("map tiles: offline default; https only (http on localhost in development); attribution and CSP host required", () => {
    const tiles = { NEXT_PUBLIC_MAP_STYLE_URL: "https://tiles.example/style.json", NEXT_PUBLIC_MAP_ATTRIBUTION: "© Example", NEXT_PUBLIC_MAP_CONNECT_SRC: "https://tiles.example" };
    expect(mapTilesCapability({})).toMatchObject({ state: "disabled" });
    expect(mapTilesCapability(tiles)).toMatchObject({ state: "enabled", provider: "tiles.example" });
    expect(mapTilesCapability({ ...tiles, NEXT_PUBLIC_MAP_ATTRIBUTION: undefined })).toMatchObject({ state: "missing", missing: ["NEXT_PUBLIC_MAP_ATTRIBUTION"] });
    expect(mapTilesCapability({ ...tiles, NEXT_PUBLIC_MAP_STYLE_URL: "http://tiles.example/style.json" })).toMatchObject({ state: "invalid" });
    const local = { NEXT_PUBLIC_MAP_STYLE_URL: "http://localhost:8080/style.json", NEXT_PUBLIC_MAP_ATTRIBUTION: "x y", NEXT_PUBLIC_MAP_CONNECT_SRC: "http://localhost:8080" };
    expect(mapTilesCapability({ ...dev, ...local })).toMatchObject({ state: "enabled" });
    expect(mapTilesCapability({ ...prod, ...local })).toMatchObject({ state: "invalid" });
    expect(mapTilesCapability({ ...tiles, NEXT_PUBLIC_MAP_STYLE_URL: "not a url" })).toMatchObject({ state: "invalid" });
  });
});

describe("provider capabilities: start-up", () => {
  it("passes a complete local configuration and describes it on one line", () => {
    const reports = assertCapabilities(apiCapabilities({ ...dev, DEV_AUTH_SECRET: SECRET }));
    expect(describeCapabilities(reports)).toBe("auth=enabled(dev,simulated) storage=enabled(memory,simulated) chain-events=disabled media-scanning=disabled realtime=disabled integrations=disabled");
    expect(assertCapabilities(workerCapabilities({ ...dev }))).toHaveLength(5);
    expect(assertCapabilities(webCapabilities({}))).toHaveLength(4);
  });

  it("fails closed on missing or invalid configuration, naming variables but never printing values", () => {
    const env = { ...prod, AUTH_PROVIDER: "oidc", OIDC_ISSUER_URL: "https://id.example", STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: SECRET, S3_ENDPOINT: "http://s3.internal" };
    let err: unknown;
    try {
      assertCapabilities(apiCapabilities(env));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CapabilityConfigError);
    const message = (err as Error).message;
    expect(message).toContain("auth (identity) missing: missing OIDC_AUDIENCE");
    expect(message).toContain("storage (storage) invalid: S3_ENDPOINT must use https when deployed");
    for (const value of [SECRET, "https://id.example", "http://s3.internal"]) expect(message).not.toContain(value);
    expect(describeCapabilities((err as CapabilityConfigError).reports)).not.toContain(SECRET);
  });

  it("a development or preview configuration cannot claim a provider it does not have", () => {
    // Optional providers stay disabled (not enabled) when unconfigured; the simulated ones are labelled as such.
    const reports = [...apiCapabilities({ ...dev, DEV_AUTH_SECRET: SECRET }), ...workerCapabilities({ ...dev })];
    expect(reports.filter((r) => r.state === "enabled" && !r.simulated)).toEqual([]);
  });
});
