/**
 * Provider capabilities: what each external provider integration is doing in this process, in one typed report.
 *
 * Every provider-dependent feature has exactly one of four states:
 * - `enabled`:  a provider is selected and fully configured (`provider` names it; `simulated: true` marks a
 *               development stand-in such as memory storage or mock imagery, which deployed environments refuse);
 * - `disabled`: intentionally off (the default for every optional provider); the feature is unavailable and says so;
 * - `missing`:  a provider is selected but required variables are absent (`missing` lists their NAMES);
 * - `invalid`:  configured values contradict each other or the environment (`problems` says what, never a value).
 *
 * Services call `assertCapabilities` at start-up: `missing` or `invalid` stops the process (fail closed), with a
 * message that names the capability and the variables, never their values. `describeCapabilities` is the one-line
 * start-up log. Documentation: docs/provider-capabilities.md.
 */

export type CapabilityState = "enabled" | "disabled" | "missing" | "invalid";
export type CapabilityCategory = "identity" | "storage" | "imagery" | "chain" | "telemetry" | "media" | "maps" | "realtime" | "integrations";

export interface CapabilityReport {
  capability: string;
  category: CapabilityCategory;
  state: CapabilityState;
  /** The selected provider, when one is (e.g. "oidc", "s3", "memory"). */
  provider: string | null;
  /** True for development stand-ins (memory storage, mock imagery, dev sign-in). */
  simulated: boolean;
  /** Names of required variables that are absent (state `missing`). */
  missing: string[];
  /** What is inconsistent (state `invalid`); never contains a configured value. */
  problems: string[];
  /** Why the capability is in this state, for operators. */
  note?: string;
}

type Env = Record<string, unknown>;
const set = (env: Env, k: string) => env[k] !== undefined && env[k] !== null && env[k] !== "";
const deployed = (env: Env) => env.APP_ENV === "staging" || env.APP_ENV === "production";
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function report(r: Partial<CapabilityReport> & Pick<CapabilityReport, "capability" | "category" | "state">): CapabilityReport {
  return { provider: null, simulated: false, missing: [], problems: [], ...r };
}

/** The variables a selected provider needs; `missing` when any is absent. */
function requires(base: Omit<CapabilityReport, "state" | "missing" | "problems" | "simulated"> & { simulated?: boolean }, env: Env, names: string[]): CapabilityReport {
  const missing = names.filter((n) => !set(env, n));
  return report({ ...base, state: missing.length ? "missing" : "enabled", missing });
}

export function identityCapability(env: Env): CapabilityReport {
  const base = { capability: "auth", category: "identity" as const };
  if (env.AUTH_PROVIDER === "oidc") return requires({ ...base, provider: "oidc" }, env, ["OIDC_ISSUER_URL", "OIDC_AUDIENCE"]);
  const r = requires({ ...base, provider: "dev", simulated: true, note: "development sign-in (tokens signed with DEV_AUTH_SECRET); refused when deployed" }, env, ["DEV_AUTH_SECRET"]);
  return deployed(env) ? { ...r, state: "invalid", problems: ["dev sign-in is not allowed in staging/production"] } : r;
}

export function storageCapability(env: Env): CapabilityReport {
  const base = { capability: "storage", category: "storage" as const };
  if (env.STORAGE_DRIVER === "s3") {
    const r = requires({ ...base, provider: "s3" }, env, ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    if (r.state === "enabled" && deployed(env) && typeof env.S3_ENDPOINT === "string" && env.S3_ENDPOINT.startsWith("http://")) {
      return { ...r, state: "invalid", problems: ["S3_ENDPOINT must use https when deployed (APP_ENV staging/production); an isolated preview (APP_ENV development/test behind PREVIEW_ACCESS_GATE) may use http"] };
    }
    return r;
  }
  const r = report({ ...base, state: "enabled", provider: "memory", simulated: true, note: "in-process memory; objects are lost on restart" });
  return deployed(env) ? { ...r, state: "invalid", problems: ["memory storage is not allowed when deployed"] } : r;
}

/** Worker only: satellite/aerial imagery. No real provider is integrated yet (decision pending); `none` is honest. */
export function imageryCapability(env: Env): CapabilityReport {
  const base = { capability: "imagery", category: "imagery" as const };
  if (env.IMAGERY_PROVIDER === "mock") {
    const r = report({ ...base, state: "enabled", provider: "mock", simulated: true, note: "fixed test scenes; never real imagery" });
    return deployed(env) ? { ...r, state: "invalid", problems: ["mock imagery is not allowed when deployed"] } : r;
  }
  return report({ ...base, state: "disabled", note: "no imagery provider selected (IMAGERY_PROVIDER=none); no scenes are fabricated" });
}

/** EVM chain reads (harvest registry, NFT contract events). */
export function evmChainCapability(env: Env): CapabilityReport {
  const base = { capability: "evm-chain", category: "chain" as const };
  const wants = ["HARVEST_REGISTRY_ADDRESS", "NFT_ERC721_ADDRESS", "NFT_ERC1155_ADDRESS"].filter((n) => set(env, n));
  if (!set(env, "CHAIN_RPC_URL")) {
    return wants.length
      ? report({ ...base, state: "missing", missing: ["CHAIN_RPC_URL"], note: `${wants.join(", ")} set without an RPC endpoint` })
      : report({ ...base, state: "disabled", note: "no CHAIN_RPC_URL; EVM indexing and harvest registration are off" });
  }
  return report({ ...base, state: "enabled", provider: "json-rpc", note: wants.length ? `contracts: ${wants.join(", ")}` : "RPC only" });
}

/** Solana RPC and DAS (ownership reads, cNFT registrations, preflight). Signing keys are not part of this report. */
export function solanaCapability(env: Env): CapabilityReport {
  const base = { capability: "solana-rpc", category: "chain" as const };
  if (!set(env, "RWA_SOLANA_RPC_URL")) {
    return set(env, "RWA_SOLANA_DAS_URL")
      ? report({ ...base, state: "missing", missing: ["RWA_SOLANA_RPC_URL"], note: "RWA_SOLANA_DAS_URL set without an RPC endpoint" })
      : report({ ...base, state: "disabled", note: "no Solana RPC configured; chain reads are off" });
  }
  const network = typeof env.RWA_SOLANA_NETWORK === "string" ? env.RWA_SOLANA_NETWORK : "solana-devnet";
  if (network === "solana-mainnet" && env.RWA_MAINNET_ENABLED !== true && env.RWA_MAINNET_ENABLED !== "true") {
    return report({ ...base, state: "invalid", provider: network, problems: ["RWA_SOLANA_NETWORK is solana-mainnet but RWA_MAINNET_ENABLED is off (use solana-devnet, or turn the mainnet switch on only with its sign-off)"] });
  }
  return report({ ...base, state: "enabled", provider: network, note: set(env, "RWA_SOLANA_DAS_URL") ? "with DAS" : "RPC only (no DAS)" });
}

/** API only: provider-neutral chain event webhooks (adapters are checked when the routes register). */
export function chainEventsCapability(env: Env): CapabilityReport {
  const providers = list(env.CHAIN_EVENT_PROVIDERS);
  if (providers.includes("metafarm-fixture") && deployed(env)) {
    return report({ capability: "chain-events", category: "chain", state: "invalid", provider: providers.join(","), simulated: true, problems: ["CHAIN_EVENT_PROVIDERS includes the CI fixture adapter (metafarm-fixture), which is refused when deployed"] });
  }
  return providers.length
    ? report({ capability: "chain-events", category: "chain", state: "enabled", provider: providers.join(","), note: "hints only: tracked assets are re-read from the verified chain source" })
    : report({ capability: "chain-events", category: "chain", state: "disabled", note: "CHAIN_EVENT_PROVIDERS is empty" });
}

/** Worker only: MQTT telemetry (TLS is enforced by the schema). */
export function telemetryCapability(env: Env): CapabilityReport {
  return set(env, "MQTT_URL")
    ? report({ capability: "mqtt-telemetry", category: "telemetry", state: "enabled", provider: "mqtt" })
    : report({ capability: "mqtt-telemetry", category: "telemetry", state: "disabled", note: "no MQTT_URL; sensors post through the API instead" });
}

/** API only: upload content scanning. No scanner is integrated (decision pending); uploads are size- and type-checked only. */
export function mediaScanningCapability(): CapabilityReport {
  return report({ capability: "media-scanning", category: "media", state: "disabled", note: "no malware scanner integrated; uploads are checked for declared size and content type only (docs/threat-model.md)" });
}

/** API only: the authenticated realtime channel (WebSocket /v1/realtime). Off by default; refused when deployed until reviewed. */
export function realtimeCapability(env: Env): CapabilityReport {
  const base = { capability: "realtime", category: "realtime" as const };
  if (env.REALTIME_EVENTS_ENABLED !== true && env.REALTIME_EVENTS_ENABLED !== "true") return report({ ...base, state: "disabled", note: "clients poll; GET /v1/realtime does not exist" });
  if (deployed(env)) return report({ ...base, state: "invalid", provider: "websocket", problems: ["REALTIME_EVENTS_ENABLED is refused in staging/production until the channel is security-reviewed"] });
  return report({ ...base, state: "enabled", provider: "websocket", note: "metafarm-realtime.1 over WebSocket; polling stays available" });
}

/** API only: registered integrations (signed sensor and observation feeds). Disabled without a server key. */
export function integrationsCapability(env: Env): CapabilityReport {
  const base = { capability: "integrations", category: "integrations" as const };
  if (!set(env, "INTEGRATION_SECRET_KEY")) return report({ ...base, state: "disabled", note: "no INTEGRATION_SECRET_KEY; integration routes answer 404" });
  if (String(env.INTEGRATION_SECRET_KEY).length < 32) return report({ ...base, state: "invalid", problems: ["INTEGRATION_SECRET_KEY must be at least 32 characters"] });
  return report({ ...base, state: "enabled", provider: "hmac", note: "per-integration secrets derived from the server key; workspace from the integration only" });
}

type ParsedUrl = { ok: true; url: URL } | { ok: false };
function parseUrl(v: unknown): ParsedUrl {
  try {
    return { ok: true, url: new URL(String(v)) };
  } catch {
    return { ok: false };
  }
}
const isLocal = (u: URL) => u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
/** https, or http to localhost outside deployed environments. */
const secureEnough = (u: URL, env: Env) => u.protocol === "https:" || (u.protocol === "http:" && isLocal(u) && !deployed(env));
const words = (v: unknown) => (typeof v === "string" ? v.split(/\s+/).filter(Boolean) : []);
/** A CSP source as written in *_CONNECT_SRC: an origin, a scheme-less host (https assumed) or `https://*.example`. */
const parseSource = (v: string): ParsedUrl => parseUrl(v.includes("://") ? v : `https://${v}`);
const sourceAllows = (source: URL, target: URL) =>
  source.protocol === target.protocol &&
  (source.hostname.startsWith("*.") ? target.hostname.endsWith(source.hostname.slice(1)) : source.host === target.host);

/**
 * NEXT_PUBLIC_MAP_ATTRIBUTION value declaring that the style itself carries the provider's attribution (MapLibre
 * displays the sources' attribution). An explicit declaration, so attribution is never left out by accident.
 */
export const MAP_ATTRIBUTION_FROM_STYLE = "from-style";

/**
 * Web: basemap tiles. Unset = the built-in offline style (no imagery, no place names), which is an honest default.
 * Enabled needs an https style URL, attribution (tile licences require it: the text, or `from-style` when the style
 * carries it) and the style's origin in NEXT_PUBLIC_MAP_CONNECT_SRC (otherwise the Content-Security-Policy blocks the tiles and the map silently breaks).
 */
export function mapTilesCapability(env: Env): CapabilityReport {
  const base = { capability: "map-tiles", category: "maps" as const };
  if (!set(env, "NEXT_PUBLIC_MAP_STYLE_URL")) {
    return set(env, "NEXT_PUBLIC_MAP_ATTRIBUTION") || set(env, "NEXT_PUBLIC_MAP_CONNECT_SRC")
      ? report({ ...base, state: "missing", missing: ["NEXT_PUBLIC_MAP_STYLE_URL"], note: "attribution or map hosts set without a style URL" })
      : report({ ...base, state: "disabled", note: "built-in offline style (graticule only)" });
  }
  const p = parseUrl(env.NEXT_PUBLIC_MAP_STYLE_URL);
  if (!p.ok || !secureEnough(p.url, env)) {
    return report({ ...base, state: "invalid", problems: [`NEXT_PUBLIC_MAP_STYLE_URL must be an https URL${deployed(env) ? " when deployed" : ""}`] });
  }
  const missing = ["NEXT_PUBLIC_MAP_ATTRIBUTION", "NEXT_PUBLIC_MAP_CONNECT_SRC"].filter((n) => !set(env, n));
  if (missing.length) return report({ ...base, state: "missing", provider: p.url.hostname, missing, note: "tile providers require attribution; the CSP must allow the tile hosts" });
  if (String(env.NEXT_PUBLIC_MAP_ATTRIBUTION).trim().length < 2) return report({ ...base, state: "invalid", provider: p.url.hostname, problems: ["NEXT_PUBLIC_MAP_ATTRIBUTION is blank"] });
  const hosts = words(env.NEXT_PUBLIC_MAP_CONNECT_SRC).map(parseSource);
  if (hosts.some((h) => !h.ok || !secureEnough(h.url, env))) return report({ ...base, state: "invalid", provider: p.url.hostname, problems: ["NEXT_PUBLIC_MAP_CONNECT_SRC must list https origins"] });
  if (!hosts.some((h) => h.ok && sourceAllows(h.url, p.url))) {
    return report({ ...base, state: "invalid", provider: p.url.hostname, problems: ["NEXT_PUBLIC_MAP_CONNECT_SRC does not include the origin of NEXT_PUBLIC_MAP_STYLE_URL"] });
  }
  return report({
    ...base,
    state: "enabled",
    provider: p.url.hostname,
    note: env.NEXT_PUBLIC_MAP_ATTRIBUTION === MAP_ATTRIBUTION_FROM_STYLE ? "attribution shown from the style's own sources" : "attribution text configured",
  });
}

/**
 * Web: globe imagery and terrain (optional Cesium adapter, packages/map-scene). No imagery or terrain source is
 * chosen (decision pending) and Cesium is not bundled, so the capability is disabled; switching it on is refused
 * rather than showing an empty globe or a provider nobody licensed.
 */
export function webImageryCapability(env: Env): CapabilityReport {
  const base = { capability: "globe-imagery", category: "imagery" as const };
  const on = env.NEXT_PUBLIC_CESIUM_ENABLED === true || env.NEXT_PUBLIC_CESIUM_ENABLED === "true";
  return on
    ? report({ ...base, state: "invalid", provider: "cesium", problems: ["NEXT_PUBLIC_CESIUM_ENABLED is on, but no licensed imagery or terrain source is configured (decision pending)"] })
    : report({ ...base, state: "disabled", note: "2D map only; no globe imagery source chosen" });
}

/**
 * Web: direct browser uploads to object storage (presigned PUT). The storage origins must be in
 * NEXT_PUBLIC_UPLOAD_CONNECT_SRC for the CSP to allow them; unset = uploads disabled in the browser.
 */
export function webMediaCapability(env: Env): CapabilityReport {
  const base = { capability: "media-uploads", category: "media" as const };
  if (!set(env, "NEXT_PUBLIC_UPLOAD_CONNECT_SRC")) return report({ ...base, state: "disabled", note: "no upload origin allowed by the CSP; browser uploads are unavailable" });
  const hosts = words(env.NEXT_PUBLIC_UPLOAD_CONNECT_SRC).map(parseSource);
  if (hosts.some((h) => !h.ok || !secureEnough(h.url, env) || h.url.pathname !== "/")) {
    return report({ ...base, state: "invalid", problems: [`NEXT_PUBLIC_UPLOAD_CONNECT_SRC must list origins only${deployed(env) ? ", https when deployed" : " (https, or http on localhost)"}`] });
  }
  return report({ ...base, state: "enabled", provider: hosts.map((h) => (h.ok ? h.url.hostname : "")).join(",") });
}

/**
 * Web: realtime updates from the API's WebSocket channel (GET /v1/realtime). Unset = polling only (the default).
 * The URL must be the channel's own (`wss://host/v1/realtime`; `ws://` only for localhost in development), with no
 * credentials, query or fragment: the browser authenticates with the session token as a subprotocol, never in the
 * URL. Refused in staging/production, like the API's channel, until it is security-reviewed. The CSP allows exactly
 * this origin and nothing wider.
 */
export function webRealtimeCapability(env: Env): CapabilityReport {
  const base = { capability: "realtime", category: "realtime" as const };
  if (!set(env, "NEXT_PUBLIC_REALTIME_URL")) return report({ ...base, state: "disabled", note: "polling only" });
  const p = parseUrl(env.NEXT_PUBLIC_REALTIME_URL);
  const local = p.ok && isLocal(p.url);
  if (!p.ok || !(p.url.protocol === "wss:" || (p.url.protocol === "ws:" && local && !deployed(env)))) {
    return report({ ...base, state: "invalid", problems: ["NEXT_PUBLIC_REALTIME_URL must be a wss:// URL (ws:// only for localhost in development)"] });
  }
  if (p.url.pathname !== "/v1/realtime" || p.url.search || p.url.hash || p.url.username || p.url.password) {
    return report({ ...base, state: "invalid", problems: ["NEXT_PUBLIC_REALTIME_URL must be the channel URL (/v1/realtime) without credentials, query or fragment"] });
  }
  if (deployed(env)) return report({ ...base, state: "invalid", provider: p.url.host, problems: ["NEXT_PUBLIC_REALTIME_URL is refused in staging/production until the realtime channel is security-reviewed"] });
  return report({ ...base, state: "enabled", provider: p.url.host, note: "WebSocket with polling fallback" });
}

export const apiCapabilities = (env: Env): CapabilityReport[] => [
  identityCapability(env),
  storageCapability(env),
  chainEventsCapability(env),
  mediaScanningCapability(),
  realtimeCapability(env),
  integrationsCapability(env),
];
export const workerCapabilities = (env: Env): CapabilityReport[] => [storageCapability(env), imageryCapability(env), evmChainCapability(env), solanaCapability(env), telemetryCapability(env)];
export const webCapabilities = (env: Env): CapabilityReport[] => [mapTilesCapability(env), webImageryCapability(env), webMediaCapability(env), webRealtimeCapability(env)];

/** One line for the start-up log: `auth=enabled(oidc) storage=enabled(memory,simulated) imagery=disabled …`. */
export function describeCapabilities(reports: CapabilityReport[]): string {
  return reports
    .map((r) => {
      const detail = [r.provider, r.simulated ? "simulated" : null, ...r.missing.map((m) => `missing ${m}`)].filter(Boolean).join(",");
      return `${r.capability}=${r.state}${detail ? `(${detail})` : ""}`;
    })
    .join(" ");
}

export class CapabilityConfigError extends Error {
  constructor(readonly reports: CapabilityReport[]) {
    super(
      `provider configuration is incomplete or invalid: ${reports
        .map((r) => `${r.capability} (${r.category}) ${r.state}${r.missing.length ? `: missing ${r.missing.join(", ")}` : ""}${r.problems.length ? `: ${r.problems.join("; ")}` : ""}`)
        .join(" | ")}`,
    );
    this.name = "CapabilityConfigError";
  }
}

/** Fail closed: any `missing` or `invalid` capability stops start-up. Returns the reports otherwise. */
export function assertCapabilities(reports: CapabilityReport[]): CapabilityReport[] {
  const bad = reports.filter((r) => r.state === "missing" || r.state === "invalid");
  if (bad.length) throw new CapabilityConfigError(bad);
  return reports;
}
