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
export type CapabilityCategory = "identity" | "storage" | "imagery" | "chain" | "telemetry" | "media" | "maps";

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
      return { ...r, state: "invalid", problems: ["S3_ENDPOINT must use https when deployed"] };
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
    return report({ ...base, state: "invalid", provider: network, problems: ["RWA_SOLANA_NETWORK is solana-mainnet but RWA_MAINNET_ENABLED is off"] });
  }
  return report({ ...base, state: "enabled", provider: network, note: set(env, "RWA_SOLANA_DAS_URL") ? "with DAS" : "RPC only (no DAS)" });
}

/** API only: provider-neutral chain event webhooks (adapters are checked when the routes register). */
export function chainEventsCapability(env: Env): CapabilityReport {
  const providers = list(env.CHAIN_EVENT_PROVIDERS);
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

/** Web: basemap tiles. Unset = the built-in offline style (no imagery, no place names), which is an honest default. */
export function mapTilesCapability(env: Env): CapabilityReport {
  const base = { capability: "map-tiles", category: "maps" as const };
  const url = env.NEXT_PUBLIC_MAP_STYLE_URL;
  if (!set(env, "NEXT_PUBLIC_MAP_STYLE_URL")) return report({ ...base, state: "disabled", note: "built-in offline style (graticule only)" });
  let parsed: URL | null = null;
  try {
    parsed = new URL(String(url));
  } catch {
    parsed = null;
  }
  const local = parsed !== null && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (!parsed || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local && !deployed(env)))) {
    return report({ ...base, state: "invalid", problems: ["NEXT_PUBLIC_MAP_STYLE_URL must be an https URL"] });
  }
  if (!set(env, "NEXT_PUBLIC_MAP_ATTRIBUTION")) return report({ ...base, state: "missing", provider: parsed.hostname, missing: ["NEXT_PUBLIC_MAP_ATTRIBUTION"], note: "tile providers require attribution" });
  return report({ ...base, state: "enabled", provider: parsed.hostname });
}

export const apiCapabilities = (env: Env): CapabilityReport[] => [identityCapability(env), storageCapability(env), chainEventsCapability(env), mediaScanningCapability()];
export const workerCapabilities = (env: Env): CapabilityReport[] => [storageCapability(env), imageryCapability(env), evmChainCapability(env), solanaCapability(env), telemetryCapability(env)];
export const webCapabilities = (env: Env): CapabilityReport[] => [mapTilesCapability(env)];

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
