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
 * Fixed, sanitized categories for a method probe's error. Assigned only when the response clearly
 * says so; anything else is `unknown`. The provider's own text is read to classify but never kept,
 * logged or returned.
 */
export const PROBE_CATEGORIES = ["asset_not_found", "unauthorized", "rate_limited", "plan_restricted", "method_not_found", "unknown"] as const;
export type ProbeCategory = (typeof PROBE_CATEGORIES)[number];

/**
 * What a probe establishes about the method itself:
 * - `recognized`: the endpoint answered with a result, or clearly said the asset does not exist
 *   (so it knows the method). This is not proof that a real asset or proof can be retrieved.
 * - `not_supported`: it clearly does not know the method.
 * - `inconclusive`: anything else, including auth, rate limits, plan limits, transport errors and
 *   generic JSON-RPC errors such as -32000 on their own.
 */
export type ProbeOutcome = "recognized" | "not_supported" | "inconclusive";

export interface MethodProbe {
  method: string;
  outcome: ProbeOutcome;
  /** Only for an error answer or no answer; absent when the endpoint returned a result. */
  category?: ProbeCategory;
  /** Scheme and host only. */
  endpoint: string;
  /** Fixed-form facts only: `http <status>`, `rpc <code>`, `rpc error`, `timeout`, `network error`, `not a JSON-RPC answer`, `result`. Never provider text. */
  detail: string;
}

const RULES: { category: Exclude<ProbeCategory, "unknown">; message: RegExp }[] = [
  { category: "unauthorized", message: /\b(unauthori[sz]ed|forbidden|access denied|invalid api[- ]?key|api[- ]?key (is )?(missing|invalid|required)|missing api[- ]?key|authentication (failed|required))\b/i },
  { category: "rate_limited", message: /\b(rate[- ]?limit(ed)?|too many requests|request limit (exceeded|reached)|credits? (exhausted|exceeded))\b/i },
  { category: "plan_restricted", message: /\b((upgrade|paid|higher) (your )?plan|plan (does not|doesn't) (support|include|allow)|not (available|supported|included|allowed) (on|in|for) (your|the|this) (current |free )?plan|requires? an? (paid|higher|upgraded) plan)\b/i },
  { category: "method_not_found", message: /\b(method not found|unknown method|method .{0,40}(not found|not supported|does not exist|unsupported)|unsupported method)\b/i },
  { category: "asset_not_found", message: /\b(asset (was )?not found|could not find (the )?asset|no asset (found|exists)|asset .{0,40}does not exist|not found.{0,20}asset)\b/i },
];

/** Classifies an error answer from what it clearly states; `unknown` unless one rule matches. */
export function classifyRpcError(e: { httpStatus?: number; code?: unknown; message?: unknown }): ProbeCategory {
  if (e.httpStatus === 401 || e.httpStatus === 403) return "unauthorized";
  if (e.httpStatus === 429 || e.code === -32429) return "rate_limited";
  if (e.httpStatus === 402) return "plan_restricted";
  if (e.code === -32601) return "method_not_found";
  const text = typeof e.message === "string" ? e.message.slice(0, 500) : "";
  if (!text) return "unknown";
  const hits = RULES.filter((r) => r.message.test(text)).map((r) => r.category);
  // Only an unambiguous message classifies: one category, or auth/limits outranking "not found".
  for (const c of ["unauthorized", "rate_limited", "plan_restricted"] as const) if (hits.includes(c)) return c;
  if (hits.includes("method_not_found") && !hits.includes("asset_not_found")) return "method_not_found";
  if (hits.includes("asset_not_found") && !hits.includes("method_not_found")) return "asset_not_found";
  return "unknown";
}

const outcomeOf = (c: ProbeCategory): ProbeOutcome => (c === "asset_not_found" ? "recognized" : c === "method_not_found" ? "not_supported" : "inconclusive");

/**
 * Whether an endpoint knows a JSON-RPC method, asked with an id that is not an asset. Read-only;
 * used by the worker's opt-in preflight. Reports the endpoint by scheme and host only, and never
 * returns the provider's error text: only a fixed category, outcome and code.
 */
export async function probeSolanaMethod(c: { url: string; method: string; params: unknown; timeoutMs?: number; fetchImpl?: Fetch }): Promise<MethodProbe> {
  const endpoint = redactEndpoint(c.url);
  const fetchImpl = c.fetchImpl ?? (fetch as unknown as Fetch);
  const controller = new AbortController();
  const timeoutMs = c.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const err = (category: ProbeCategory, detail: string): MethodProbe => ({ method: c.method, outcome: outcomeOf(category), category, endpoint, detail });
  try {
    let status = 0;
    let body: unknown;
    try {
      const res = await fetchImpl(c.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: c.method, params: c.params }),
        signal: controller.signal,
      });
      status = res.status;
      body = await res.json().catch(() => undefined);
      if (!res.ok) {
        const e = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
        return err(classifyRpcError({ httpStatus: status, code: e?.code, message: e?.message }), `http ${status}`);
      }
    } catch {
      if (controller.signal.aborted) return err("unknown", "timeout");
      return err("unknown", "network error");
    }
    const r = body as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null | undefined;
    if (!r || typeof r !== "object") return err("unknown", "not a JSON-RPC answer");
    if (r.error && typeof r.error === "object") {
      const code = typeof r.error.code === "number" ? r.error.code : undefined;
      return err(classifyRpcError({ httpStatus: status, code, message: r.error.message }), code !== undefined ? `rpc ${code}` : "rpc error");
    }
    if ("result" in r) return { method: c.method, outcome: "recognized", endpoint, detail: "result" };
    return err("unknown", "not a JSON-RPC answer");
  } finally {
    clearTimeout(timer);
  }
}
