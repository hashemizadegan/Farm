/**
 * Which Solana cluster an endpoint actually serves. The configured network is only a label: a key
 * works on every cluster, so an RPC or DAS URL pointing at another cluster would sign and send real
 * transactions there. `getGenesisHash` identifies the cluster; anything other than the expected hash,
 * or no answer at all, fails closed.
 *
 * Errors and log output carry only `redactEndpoint(url)` (scheme and host), never the URL itself:
 * provider URLs usually embed an API key in the path or query.
 */
import type { Network } from "@metafarm/domain";
import { base58Decode } from "./base58";

/**
 * Genesis hash of each supported cluster. Source: Anza (Agave validator) documentation, "Available
 * Solana Clusters", the `--expected-genesis-hash` given for each cluster:
 * https://docs.anza.xyz/clusters/available (docs.solanalabs.com redirects there).
 * - solana-devnet  → Devnet
 * - solana-mainnet → Mainnet Beta
 */
export const SOLANA_GENESIS_HASHES = {
  "solana-devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "solana-mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const satisfies Partial<Record<Network, string>>;

export type SolanaNetwork = keyof typeof SOLANA_GENESIS_HASHES;

/**
 * - `mismatch`: the endpoint answered with another cluster's genesis hash (a configuration error).
 * - `invalid_response`: it answered, but not with a genesis hash (not a Solana JSON-RPC endpoint).
 * - `unavailable`: no usable answer (network error, timeout, HTTP error, JSON-RPC error).
 */
export type ClusterCheckFailure = "mismatch" | "invalid_response" | "unavailable";

export class ClusterVerificationError extends Error {
  constructor(
    readonly reason: ClusterCheckFailure,
    /** Scheme and host only. */
    readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = "ClusterVerificationError";
  }
}

/** Scheme and host of a URL, nothing else: no credentials, path, query or fragment. */
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname !== "/" || u.search || u.hash ? "/[redacted]" : "";
    return `${u.protocol}//${u.host}${rest}`;
  } catch {
    return "[invalid URL]";
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClusterCheck {
  url: string;
  network: Network;
  /** What the endpoint is for, in messages: "RPC" or "DAS". */
  label: string;
  /** Per attempt. */
  timeoutMs?: number;
  /** Attempts when the endpoint is unavailable; a mismatch or invalid answer is never retried. */
  attempts?: number;
  retryDelayMs?: number;
  fetchImpl?: Fetch;
}

/** Resolves when the endpoint serves the configured cluster; otherwise throws ClusterVerificationError. */
export async function verifySolanaCluster(c: ClusterCheck): Promise<void> {
  const endpoint = redactEndpoint(c.url);
  const expected = (SOLANA_GENESIS_HASHES as Partial<Record<Network, string>>)[c.network];
  if (!expected) throw new ClusterVerificationError("mismatch", endpoint, `${c.label} endpoint: ${c.network} is not a Solana cluster this platform knows`);
  const attempts = Math.max(1, c.attempts ?? 3);
  let last: ClusterVerificationError | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, c.retryDelayMs ?? 2_000));
    const got = await genesisHashOnce(c, endpoint);
    if (typeof got !== "string") {
      if (got.reason !== "unavailable") throw got;
      last = got;
      continue;
    }
    if (got !== expected) {
      const other = Object.entries(SOLANA_GENESIS_HASHES).find(([, h]) => h === got)?.[0];
      throw new ClusterVerificationError("mismatch", endpoint, `${c.label} endpoint ${endpoint} serves ${other ?? "an unknown cluster"}, not ${c.network}`);
    }
    return;
  }
  throw last!;
}

async function genesisHashOnce(c: ClusterCheck, endpoint: string): Promise<string | ClusterVerificationError> {
  const fetchImpl = c.fetchImpl ?? (fetch as unknown as Fetch);
  const unavailable = (why: string) => new ClusterVerificationError("unavailable", endpoint, `${c.label} endpoint ${endpoint} could not be verified: ${why}`);
  const controller = new AbortController();
  const timeoutMs = c.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let body: unknown;
    try {
      const res = await fetchImpl(c.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
        signal: controller.signal,
      });
      if (!res.ok) return unavailable(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      // The underlying message may name the URL; report only a timeout or a short error code.
      if (controller.signal.aborted) return unavailable(`no answer within ${timeoutMs} ms`);
      const code = (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
      return unavailable(typeof code === "string" && /^[A-Z_]{2,32}$/.test(code) ? code : "request failed");
    }
    const r = body as { result?: unknown; error?: { code?: unknown } } | null;
    if (r && typeof r === "object" && r.error) return unavailable(`JSON-RPC error ${typeof r.error.code === "number" ? r.error.code : ""}`.trim());
    const hash = r && typeof r === "object" ? r.result : undefined;
    if (typeof hash !== "string" || !isHash(hash)) return new ClusterVerificationError("invalid_response", endpoint, `${c.label} endpoint ${endpoint} did not return a genesis hash`);
    return hash;
  } finally {
    clearTimeout(timer);
  }
}

function isHash(s: string): boolean {
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * Whether an endpoint knows a JSON-RPC method, without needing a real answer: any reply other
 * than "method not found" (-32601) means it exists (an invalid or unknown id is fine). Read-only;
 * used by the worker's opt-in preflight. Like verifySolanaCluster, it reports the endpoint by
 * scheme and host only and never echoes the URL or the endpoint's own error text.
 */
export type MethodProbe = { method: string; result: "available" | "not_found" | "unavailable"; endpoint: string; detail?: string };

export async function probeSolanaMethod(c: { url: string; method: string; params: unknown; timeoutMs?: number; fetchImpl?: Fetch }): Promise<MethodProbe> {
  const endpoint = redactEndpoint(c.url);
  const fetchImpl = c.fetchImpl ?? (fetch as unknown as Fetch);
  const controller = new AbortController();
  const timeoutMs = c.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const out = (result: MethodProbe["result"], detail?: string): MethodProbe => ({ method: c.method, result, endpoint, ...(detail ? { detail } : {}) });
  try {
    let body: unknown;
    try {
      const res = await fetchImpl(c.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: c.method, params: c.params }),
        signal: controller.signal,
      });
      if (!res.ok) return out("unavailable", `HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      if (controller.signal.aborted) return out("unavailable", `no answer within ${timeoutMs} ms`);
      const code = (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
      return out("unavailable", typeof code === "string" && /^[A-Z_]{2,32}$/.test(code) ? code : "request failed");
    }
    const r = body as { result?: unknown; error?: { code?: unknown } } | null;
    if (!r || typeof r !== "object" || (!("result" in r) && !r.error)) return out("unavailable", "not a JSON-RPC answer");
    if (r.error && r.error.code === -32601) return out("not_found", "JSON-RPC error -32601");
    return out("available", r.error ? `JSON-RPC error ${typeof r.error.code === "number" ? r.error.code : ""}`.trim() : undefined);
  } finally {
    clearTimeout(timer);
  }
}
