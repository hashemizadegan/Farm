import { describe, expect, it } from "vitest";
import { base58Decode } from "./base58";
import { ClusterVerificationError, PROBE_CATEGORIES, SOLANA_GENESIS_HASHES, classifyRpcError, probeSolanaMethod, redactEndpoint, verifySolanaCluster, type MethodProbe } from "./cluster";

// A made-up credential: it must never appear in any message.
const KEY = "k3y-not-real-0000";
const URL_WITH_KEY = `https://devnet.rpc.invalid/v2/${KEY}?api-key=${KEY}`;
const DEVNET = SOLANA_GENESIS_HASHES["solana-devnet"];
const MAINNET = SOLANA_GENESIS_HASHES["solana-mainnet"];

type Answer = { status?: number; body?: unknown } | Error | "hang";
function fakeFetch(...answers: Answer[]) {
  const calls: { method: string; body: string }[] = [];
  const fetchImpl = async (_url: string, init: { method: string; body: string; signal: AbortSignal }) => {
    calls.push({ method: init.method, body: init.body });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a === "hang")
      return new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(`aborted ${URL_WITH_KEY}`))));
    if (a instanceof Error) throw a;
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, json: async () => a.body };
  };
  return { fetchImpl, calls };
}
const check = (f: ReturnType<typeof fakeFetch>, network: "solana-devnet" | "solana-mainnet" | "tron-nile" = "solana-devnet") =>
  verifySolanaCluster({ url: URL_WITH_KEY, network, label: "RPC", fetchImpl: f.fetchImpl, retryDelayMs: 1, timeoutMs: 50 });
async function failure(p: Promise<unknown>): Promise<ClusterVerificationError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ClusterVerificationError);
    const e = err as ClusterVerificationError;
    expect(e.message).not.toContain(KEY);
    expect(e.endpoint).not.toContain(KEY);
    return e;
  }
  throw new Error("expected the check to fail");
}

describe("Solana cluster verification", () => {
  it("uses the documented genesis hashes (Anza, Available Solana Clusters), 32 bytes each", () => {
    expect(SOLANA_GENESIS_HASHES).toEqual({
      "solana-devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "solana-mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    });
    for (const h of Object.values(SOLANA_GENESIS_HASHES)) expect(base58Decode(h).length).toBe(32);
  });

  it("accepts an endpoint that serves the configured cluster, asking with getGenesisHash", async () => {
    const f = fakeFetch({ body: { jsonrpc: "2.0", id: 1, result: DEVNET } });
    await check(f);
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0]!.body)).toMatchObject({ method: "getGenesisHash" });
  });

  it("refuses another cluster at once, naming it, never retrying", async () => {
    const f = fakeFetch({ body: { result: MAINNET } });
    const e = await failure(check(f));
    expect(e.reason).toBe("mismatch");
    expect(e.message).toContain("serves solana-mainnet, not solana-devnet");
    expect(f.calls).toHaveLength(1);
    // And the other way round: a devnet endpoint is not mainnet.
    expect((await failure(check(fakeFetch({ body: { result: DEVNET } }), "solana-mainnet"))).reason).toBe("mismatch");
    // An unknown cluster (e.g. testnet or a local validator) is refused too.
    expect((await failure(check(fakeFetch({ body: { result: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY" } })))).message).toContain("an unknown cluster");
  });

  it("refuses an answer that is not a genesis hash", async () => {
    for (const body of [{ result: "not-a-hash" }, { result: 42 }, {}, null, "html"]) {
      const f = fakeFetch({ body });
      expect((await failure(check(f))).reason).toBe("invalid_response");
      expect(f.calls).toHaveLength(1);
    }
  });

  it("reports an endpoint it cannot hear from as unavailable, after retrying", async () => {
    const http = fakeFetch({ status: 503 });
    const e = await failure(check(http));
    expect(e).toMatchObject({ reason: "unavailable" });
    expect(e.message).toContain("HTTP 503");
    expect(http.calls).toHaveLength(3);

    const rpcError = fakeFetch({ body: { error: { code: -32601, message: `method not found at ${URL_WITH_KEY}` } } });
    expect((await failure(check(rpcError))).message).toContain("JSON-RPC error -32601");

    const down = fakeFetch(Object.assign(new TypeError(`fetch failed ${URL_WITH_KEY}`), { cause: { code: "ENOTFOUND" } }));
    expect((await failure(check(down))).message).toContain("ENOTFOUND");

    const slow = fakeFetch("hang");
    const t = await failure(check(slow));
    expect(t.reason).toBe("unavailable");
    expect(t.message).toContain("no answer within 50 ms");
  });

  it("recovers when a retry gets an answer", async () => {
    const f = fakeFetch({ status: 502 }, { body: { result: DEVNET } });
    await check(f);
    expect(f.calls).toHaveLength(2);
  });

  it("refuses a network that is not a Solana cluster without calling it", async () => {
    const f = fakeFetch({ body: { result: DEVNET } });
    expect((await failure(check(f, "tron-nile"))).reason).toBe("mismatch");
    expect(f.calls).toHaveLength(0);
  });

  it("redacts endpoints to scheme and host", () => {
    expect(redactEndpoint(URL_WITH_KEY)).toBe("https://devnet.rpc.invalid/[redacted]");
    expect(redactEndpoint("https://user:pass@rpc.invalid:8899/")).toBe("https://rpc.invalid:8899");
    expect(redactEndpoint("https://rpc.invalid")).toBe("https://rpc.invalid");
    expect(redactEndpoint("not a url")).toBe("[invalid URL]");
    // Credentials in the user part, an "@" in the password, query, fragment, path parameters, IPv6, case.
    for (const [url, out] of [
      [`https://user:p%40ss@rpc.invalid/v2/${KEY}?api-key=${KEY}#${KEY}`, "https://rpc.invalid/[redacted]"],
      [`https://u:p@${KEY}@rpc.invalid:8899/`, "https://rpc.invalid:8899"],
      [`https://[2001:db8::1]:8899/?k=${KEY}`, "https://[2001:db8::1]:8899/[redacted]"],
      [`HTTPS://RPC.INVALID/${KEY}`, "https://rpc.invalid/[redacted]"],
      [`https://rpc.invalid/#${KEY}`, "https://rpc.invalid/[redacted]"],
      [`https://rpc.invalid:443/path;${KEY}`, "https://rpc.invalid/[redacted]"],
      [`rpc.invalid/${KEY}`, "[invalid URL]"],
    ] as const) {
      expect(redactEndpoint(url)).toBe(out);
      expect(redactEndpoint(url)).not.toContain(KEY);
    }
  });
});

describe("JSON-RPC method probe", () => {
  const probe = (f: ReturnType<typeof fakeFetch>) =>
    probeSolanaMethod({ url: URL_WITH_KEY, method: "getAsset", params: { id: "11111111111111111111111111111111" }, fetchImpl: f.fetchImpl, timeoutMs: 50 });
  // Provider text, including a credential, must never come back from a probe.
  const leaky = (m: string) => `${m} (endpoint ${URL_WITH_KEY}, key ${KEY})`;
  const clean = (p: MethodProbe) => {
    const s = JSON.stringify(p);
    expect(s).not.toContain(KEY);
    expect(s).not.toContain("endpoint https");
    if (p.category) expect(PROBE_CATEGORIES).toContain(p.category);
    return p;
  };
  const answer = async (body: unknown, status = 200) => clean(await probe(fakeFetch({ status, body })));

  it("recognizes a method only from a result or a clear asset-not-found", async () => {
    expect(await answer({ result: { id: "x" } })).toMatchObject({ outcome: "recognized", detail: "result" });
    expect(await answer({ result: null })).toMatchObject({ outcome: "recognized", detail: "result" });
    for (const message of ["Asset not found", "asset was not found", "Could not find asset", leaky("Asset Not Found")]) {
      expect(await answer({ error: { code: -32000, message } })).toMatchObject({ outcome: "recognized", category: "asset_not_found", detail: "rpc -32000" });
    }
  });

  it("never counts -32000 alone, or any unclear error, as support", async () => {
    for (const error of [{ code: -32000 }, { code: -32000, message: "Internal error" }, { code: -32000, message: "" }, { code: -32603, message: "server error" }, { code: -32602, message: "invalid params" }, { message: "something went wrong" }]) {
      expect(await answer({ error })).toMatchObject({ outcome: "inconclusive", category: "unknown" });
    }
    // Ambiguous: mentions both "method ... not found" and "asset not found".
    expect(await answer({ error: { code: -32000, message: "method getAsset: asset not found" } })).toMatchObject({ outcome: "inconclusive", category: "unknown" });
  });

  it("classifies auth, rate limits, plan limits and unknown methods, all as not establishing support", async () => {
    expect(await answer({ error: { code: -32601, message: "x" } })).toMatchObject({ outcome: "not_supported", category: "method_not_found" });
    expect(await answer({ error: { code: -32000, message: leaky("Method not found") } })).toMatchObject({ outcome: "not_supported", category: "method_not_found" });
    expect(await answer({ error: { code: -32401, message: leaky("Unauthorized: invalid api key") } })).toMatchObject({ outcome: "inconclusive", category: "unauthorized" });
    expect(await answer(undefined, 401)).toMatchObject({ outcome: "inconclusive", category: "unauthorized", detail: "http 401" });
    expect(await answer(undefined, 403)).toMatchObject({ category: "unauthorized" });
    expect(await answer(undefined, 429)).toMatchObject({ outcome: "inconclusive", category: "rate_limited", detail: "http 429" });
    expect(await answer({ error: { code: -32429, message: "slow down" } })).toMatchObject({ category: "rate_limited" });
    expect(await answer({ error: { code: -32000, message: leaky("Too many requests") } })).toMatchObject({ category: "rate_limited" });
    expect(await answer(undefined, 402)).toMatchObject({ outcome: "inconclusive", category: "plan_restricted" });
    expect(await answer({ error: { code: -32000, message: leaky("This method is not available on your current plan") } })).toMatchObject({ category: "plan_restricted" });
    expect(await answer({ error: { code: -32000, message: "Please upgrade your plan" } })).toMatchObject({ category: "plan_restricted" });
    // Auth outranks a "not found" in the same message.
    expect(await answer({ error: { code: -32000, message: "unauthorized: asset not found" } })).toMatchObject({ category: "unauthorized" });
    expect(await answer(undefined, 500)).toMatchObject({ outcome: "inconclusive", category: "unknown", detail: "http 500" });
  });

  it("reports transport failures as inconclusive, without the URL or the error text", async () => {
    expect(clean(await probe(fakeFetch("hang")))).toMatchObject({ outcome: "inconclusive", category: "unknown", detail: "timeout" });
    expect(clean(await probe(fakeFetch(Object.assign(new TypeError(`fetch failed ${URL_WITH_KEY}`), { cause: { code: "ECONNREFUSED" } }))))).toMatchObject({ outcome: "inconclusive", detail: "network error" });
    expect(await answer("<html>")).toMatchObject({ outcome: "inconclusive", detail: "not a JSON-RPC answer" });
    expect(await answer({})).toMatchObject({ outcome: "inconclusive", detail: "not a JSON-RPC answer" });
    expect((await probe(fakeFetch({ body: {} }))).endpoint).toBe("https://devnet.rpc.invalid/[redacted]");
  });

  it("classifies from clear statements only", () => {
    expect(classifyRpcError({})).toBe("unknown");
    expect(classifyRpcError({ code: -32000 })).toBe("unknown");
    expect(classifyRpcError({ message: 42 })).toBe("unknown");
    expect(classifyRpcError({ message: "not found" })).toBe("unknown"); // neither asset nor method named
    expect(classifyRpcError({ message: "plan" })).toBe("unknown");
  });
});
