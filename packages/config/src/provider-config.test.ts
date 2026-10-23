/**
 * Web provider configuration (build and runtime) and deployment compatibility of the start-up rules:
 * - web: map tiles, attribution, globe imagery and browser media uploads, failing closed with variable names only;
 * - API/worker: an isolated preview configuration passes, while unsafe settings (http object storage when deployed,
 *   Solana mainnet without its switch, realtime when deployed, a short integration key) are refused with diagnostics.
 */
import { describe, expect, it } from "vitest";
import {
  CapabilityConfigError,
  apiCapabilities,
  assertCapabilities,
  integrationsCapability,
  mapTilesCapability,
  realtimeCapability,
  solanaCapability,
  storageCapability,
  webCapabilities,
  webImageryCapability,
  webMediaCapability,
  workerCapabilities,
} from "./capabilities";

const TILES = {
  NEXT_PUBLIC_MAP_STYLE_URL: "https://tiles.example.org/styles/basic/style.json?key=SECRET-TILE-KEY",
  NEXT_PUBLIC_MAP_ATTRIBUTION: "© Example contributors",
  NEXT_PUBLIC_MAP_CONNECT_SRC: "https://tiles.example.org",
};
const failure = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CapabilityConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a configuration error");
};

describe("web provider configuration", () => {
  it("valid: an https style with attribution and its host allowed by the CSP", () => {
    expect(assertCapabilities(webCapabilities({ APP_ENV: "production", ...TILES })).map((r) => [r.capability, r.state])).toEqual([
      ["map-tiles", "enabled"],
      ["globe-imagery", "disabled"],
      ["media-uploads", "disabled"],
    ]);
    // Wildcard and scheme-less CSP sources are understood.
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_CONNECT_SRC: "https://*.example.org" })).toMatchObject({ state: "enabled" });
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_CONNECT_SRC: "tiles.example.org" })).toMatchObject({ state: "enabled" });
    // A style that carries its own attribution says so explicitly.
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_ATTRIBUTION: "from-style" })).toMatchObject({ state: "enabled", note: "attribution shown from the style's own sources" });
  });

  it("disabled: nothing set is the built-in offline style, no globe, no browser uploads", () => {
    expect(webCapabilities({ APP_ENV: "production" }).map((r) => r.state)).toEqual(["disabled", "disabled", "disabled"]);
  });

  it("missing tile URL: attribution or hosts without a style URL", () => {
    expect(mapTilesCapability({ NEXT_PUBLIC_MAP_ATTRIBUTION: "© x" })).toMatchObject({ state: "missing", missing: ["NEXT_PUBLIC_MAP_STYLE_URL"] });
    expect(mapTilesCapability({ NEXT_PUBLIC_MAP_CONNECT_SRC: "https://tiles.example.org" })).toMatchObject({ state: "missing", missing: ["NEXT_PUBLIC_MAP_STYLE_URL"] });
  });

  it("missing attribution (and missing or mismatched CSP host)", () => {
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_ATTRIBUTION: "" })).toMatchObject({ state: "missing", missing: ["NEXT_PUBLIC_MAP_ATTRIBUTION"] });
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_ATTRIBUTION: " " })).toMatchObject({ state: "invalid", problems: ["NEXT_PUBLIC_MAP_ATTRIBUTION is blank"] });
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_CONNECT_SRC: undefined })).toMatchObject({ state: "missing", missing: ["NEXT_PUBLIC_MAP_CONNECT_SRC"] });
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_CONNECT_SRC: "https://other.example.net" })).toMatchObject({ state: "invalid" });
  });

  it("malformed URLs", () => {
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_STYLE_URL: "tiles.example.org/style.json" })).toMatchObject({ state: "invalid" });
    expect(mapTilesCapability({ ...TILES, NEXT_PUBLIC_MAP_CONNECT_SRC: "https://" })).toMatchObject({ state: "invalid" });
    expect(webMediaCapability({ NEXT_PUBLIC_UPLOAD_CONNECT_SRC: "https://bucket.example.org/uploads" })).toMatchObject({ state: "invalid" });
  });

  it("incompatible environment: http hosts are development-only; the globe has no licensed source", () => {
    const local = { NEXT_PUBLIC_MAP_STYLE_URL: "http://localhost:8080/style.json", NEXT_PUBLIC_MAP_ATTRIBUTION: "© local", NEXT_PUBLIC_MAP_CONNECT_SRC: "http://localhost:8080" };
    expect(mapTilesCapability({ APP_ENV: "development", ...local })).toMatchObject({ state: "enabled" });
    expect(mapTilesCapability({ APP_ENV: "staging", ...local })).toMatchObject({ state: "invalid" });
    expect(webMediaCapability({ APP_ENV: "development", NEXT_PUBLIC_UPLOAD_CONNECT_SRC: "http://localhost:9000" })).toMatchObject({ state: "enabled" });
    expect(webMediaCapability({ APP_ENV: "production", NEXT_PUBLIC_UPLOAD_CONNECT_SRC: "http://localhost:9000" })).toMatchObject({ state: "invalid" });
    expect(webImageryCapability({ NEXT_PUBLIC_CESIUM_ENABLED: "true" })).toMatchObject({ state: "invalid" });
  });

  it("preview: the isolated preview (development behind the gate) may use local hosts and stays honest", () => {
    const preview = { APP_ENV: "development", RAILWAY_PROJECT_ID: "p", PREVIEW_ACCESS_GATE: "true", NEXT_PUBLIC_UPLOAD_CONNECT_SRC: "https://bucket.preview.example.org" };
    expect(assertCapabilities(webCapabilities(preview)).map((r) => r.state)).toEqual(["disabled", "disabled", "enabled"]);
  });

  it("production: fails closed naming variables, never values", () => {
    const message = failure(() => assertCapabilities(webCapabilities({ APP_ENV: "production", ...TILES, NEXT_PUBLIC_MAP_CONNECT_SRC: "https://elsewhere.example.net", NEXT_PUBLIC_CESIUM_ENABLED: "true" })));
    expect(message).toContain("map-tiles (maps) invalid: NEXT_PUBLIC_MAP_CONNECT_SRC does not include the origin of NEXT_PUBLIC_MAP_STYLE_URL");
    expect(message).toContain("globe-imagery (imagery) invalid: NEXT_PUBLIC_CESIUM_ENABLED is on");
    for (const value of ["SECRET-TILE-KEY", "tiles.example.org", "elsewhere.example.net", "© Example"]) expect(message).not.toContain(value);
  });
});

describe("deployment compatibility of the start-up rules", () => {
  const S3 = { STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s3-secret-value" };
  const PREVIEW = { APP_ENV: "development", RAILWAY_PROJECT_ID: "p", PREVIEW_ACCESS_GATE: "true" };

  it("accepts the isolated preview: http object storage inside the project, devnet, realtime on", () => {
    const env = { ...PREVIEW, ...S3, S3_ENDPOINT: "http://minio.railway.internal:9000", DEV_AUTH_SECRET: "x".repeat(40), RWA_SOLANA_RPC_URL: "https://api.devnet.solana.com", RWA_SOLANA_NETWORK: "solana-devnet", REALTIME_EVENTS_ENABLED: "true", INTEGRATION_SECRET_KEY: "k".repeat(40) };
    expect(assertCapabilities(apiCapabilities(env)).filter((r) => r.state === "enabled").map((r) => r.capability)).toEqual(["auth", "storage", "realtime", "integrations"]);
    expect(assertCapabilities(workerCapabilities(env)).find((r) => r.capability === "solana-rpc")).toMatchObject({ state: "enabled", provider: "solana-devnet" });
  });

  it("refuses http object storage when deployed, with a diagnostic that says what a preview may do", () => {
    const r = storageCapability({ APP_ENV: "production", ...S3, S3_ENDPOINT: "http://s3.internal.example" });
    expect(r.state).toBe("invalid");
    expect(r.problems[0]).toMatch(/^S3_ENDPOINT must use https when deployed .*preview/);
    expect(JSON.stringify(r)).not.toContain("s3.internal.example");
    expect(storageCapability({ APP_ENV: "production", ...S3, S3_ENDPOINT: "https://s3.example" })).toMatchObject({ state: "enabled" });
  });

  it("refuses Solana mainnet without RWA_MAINNET_ENABLED, in every environment", () => {
    for (const APP_ENV of ["development", "staging", "production"]) {
      const r = solanaCapability({ APP_ENV, RWA_SOLANA_RPC_URL: "https://rpc.example", RWA_SOLANA_NETWORK: "solana-mainnet" });
      expect(r.state, APP_ENV).toBe("invalid");
      expect(r.problems[0]).toMatch(/RWA_MAINNET_ENABLED is off/);
    }
  });

  it("realtime: off by default, enabled locally, refused when deployed (schema and capability agree)", () => {
    expect(realtimeCapability({})).toMatchObject({ state: "disabled" });
    expect(realtimeCapability({ APP_ENV: "development", REALTIME_EVENTS_ENABLED: true })).toMatchObject({ state: "enabled" });
    expect(realtimeCapability({ APP_ENV: "production", REALTIME_EVENTS_ENABLED: true })).toMatchObject({ state: "invalid" });
    // The API schema refuses it too (apps/api realtime-contract.test.ts parses a complete environment).
  });

  it("integrations: disabled without a key; a short key is refused by the schema and the capability", () => {
    expect(integrationsCapability({})).toMatchObject({ state: "disabled" });
    expect(integrationsCapability({ INTEGRATION_SECRET_KEY: "short" })).toMatchObject({ state: "invalid" });
    expect(integrationsCapability({ INTEGRATION_SECRET_KEY: "k".repeat(32) })).toMatchObject({ state: "enabled" });
  });
});
