/** Token-2022 issuance and Solana observation against a simulated RPC node. */
import { ed25519 } from "@noble/curves/ed25519";
import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Ed25519Signer } from "@metafarm/domain";
import { fromBase64 } from "../bytes";
import { base58Encode } from "./base58";
import { TOKEN_2022_PROGRAM, associatedTokenAddress } from "./keys";
import { SolanaObservationAdapter, SolanaSubmitError } from "./observation-adapter";
import { SolanaRpcError, type SignatureStatus, type SolanaRpc } from "./rpc";
import { SolanaToken2022Adapter, choosePriorityFee } from "./token2022-adapter";

const seed = new Uint8Array(32).fill(7);
const signer: Ed25519Signer = { address: base58Encode(ed25519.getPublicKey(seed)), signMessage: async (m) => ed25519.sign(m, seed) };
const holder = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(3));

function fakeRpc(over: Partial<SolanaRpc> = {}): SolanaRpc & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n }),
    getBlockHeight: async () => 900n,
    getMinimumBalanceForRentExemption: async (space) => BigInt(space) * 6_960n + 890_880n,
    getRecentPrioritizationFees: async () => [0n, 0n, 1_000n, 2_000n, 3_000n, 50_000n],
    sendTransaction: async (wire) => {
      sent.push(wire);
      return "sig";
    },
    getSignatureStatus: async () => null,
    ...over,
  };
}

const decode = (wire: string) => Transaction.from(Buffer.from(fromBase64(wire)));

describe("priority fees", () => {
  it("pays the 75th percentile of recent non-zero fees, within the cap", () => {
    expect(choosePriorityFee([0n, 0n], 1_000_000n)).toBe(0n);
    expect(choosePriorityFee([1_000n, 2_000n, 3_000n, 50_000n], 1_000_000n)).toBe(50_000n);
    expect(choosePriorityFee([1_000n, 2_000n, 3_000n, 4_000n, 5_000n, 6_000n, 7_000n, 8_000n], 1_000_000n)).toBe(7_000n);
    expect(choosePriorityFee([5_000_000n], 1_000_000n)).toBe(1_000_000n);
  });
});

describe("Token-2022 issuance adapter", () => {
  it("refuses mainnet until enabled, and the wrong rail", () => {
    expect(() => new SolanaToken2022Adapter({ network: "solana-mainnet", rpc: fakeRpc(), signer, mainnetEnabled: false })).toThrow(/not enabled/);
    expect(() => new SolanaToken2022Adapter({ network: "tron-nile", rpc: fakeRpc(), signer, mainnetEnabled: true })).toThrow(/not a Solana network/);
    expect(() => new SolanaToken2022Adapter({ network: "solana-mainnet", rpc: fakeRpc(), signer, mainnetEnabled: true })).not.toThrow();
  });

  it("creates a share mint with transfer fee, permanent delegate and transfer hook, signed and sized", async () => {
    const adapter = new SolanaToken2022Adapter({ network: "solana-devnet", rpc: fakeRpc(), signer, mainnetEnabled: false });
    const hook = base58Encode(new Uint8Array(32).fill(5));
    const p = await adapter.prepareCreateMint({
      network: "solana-devnet",
      decimals: 6,
      mintAuthority: signer.address,
      freezeAuthority: signer.address,
      transferFee: { basisPoints: 25, maximumFee: 10_000_000n, configAuthority: signer.address, withdrawAuthority: signer.address },
      permanentDelegate: signer.address,
      transferHookProgramId: hook,
      transferHookAuthority: signer.address,
    });
    const tx = decode(p.wire);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.signatures).toHaveLength(2);
    expect(base58Encode(tx.signature!)).toBe(p.txRef);
    expect(p.validity.lastValidBlockHeight).toBe(1_000n);
    expect(p.fees.priorityFeeMicroLamports).toBe(50_000n);
    // compute limit, compute price, create account, three extensions, then the mint.
    const programs = tx.instructions.map((i) => i.programId.toBase58());
    expect(programs.slice(2)).toEqual(["11111111111111111111111111111111", TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM]);
    expect(tx.instructions.slice(3).map((i) => i.data[0])).toEqual([26, 35, 36, 20]);
    expect(p.summary).toMatchObject({ action: "create_mint", mint: p.mintAddress, extensions: ["transferFeeConfig", "permanentDelegate", "transferHook"] });
    // Space for the mint: 166 + (4+108) + (4+32) + (4+64) = 382 bytes.
    expect(p.summary.rentLamports).toBe((382n * 6_960n + 890_880n).toString());
  });

  it("mints to the holder's token account, creating it if needed", async () => {
    const adapter = new SolanaToken2022Adapter({ network: "solana-devnet", rpc: fakeRpc({ getRecentPrioritizationFees: async () => [] }), signer, mainnetEnabled: false });
    const mint = base58Encode(new Uint8Array(32).fill(11));
    const p = await adapter.prepareIssuance({ network: "solana-devnet", action: "mint", mintAddress: mint, decimals: 6, holderAddress: holder, amount: 2_500_000n });
    const tx = decode(p.wire);
    expect(tx.verifySignatures()).toBe(true);
    // No priority fee when the network is quiet: limit, create-ATA, mint.
    expect(tx.instructions).toHaveLength(3);
    expect(tx.instructions[2]!.keys[1]!.pubkey.toBase58()).toBe(associatedTokenAddress(holder, mint));
    expect(p.summary).toMatchObject({ action: "mint", amount: "2500000", tokenAccount: associatedTokenAddress(holder, mint) });
  });

  it("checks amounts and addresses before building anything", async () => {
    const adapter = new SolanaToken2022Adapter({ network: "solana-devnet", rpc: fakeRpc(), signer, mainnetEnabled: false });
    const mint = base58Encode(new Uint8Array(32).fill(11));
    const base = { network: "solana-devnet" as const, mintAddress: mint, decimals: 6, holderAddress: holder };
    await expect(adapter.prepareIssuance({ ...base, action: "mint" })).rejects.toThrow(/amount/);
    await expect(adapter.prepareIssuance({ ...base, action: "burn", amount: 1n << 64n })).rejects.toThrow(/amount/);
    await expect(adapter.prepareIssuance({ ...base, action: "freeze", holderAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" })).rejects.toThrow(/Solana addresses/);
    await expect(adapter.prepareIssuance({ ...base, network: "solana-mainnet", action: "thaw" })).rejects.toThrow(/serves solana-devnet/);
    expect((await adapter.prepareIssuance({ ...base, action: "freeze" })).summary.action).toBe("freeze");
  });
});

describe("Solana observation adapter", () => {
  const status = (s: Partial<SignatureStatus>): SignatureStatus => ({ slot: 77n, confirmations: 3, err: null, confirmationStatus: "confirmed", ...s });
  const target = { network: "solana-devnet" as const, txRef: "sig", lastValidBlockHeight: 1_000n };

  it("reports observed, final and failed transactions", async () => {
    const at = (s: SignatureStatus | null) => new SolanaObservationAdapter({ network: "solana-devnet", rpc: fakeRpc({ getSignatureStatus: async () => s }) }).observe(target);
    expect(await at(status({}))).toEqual({ status: "observed", slotOrBlock: 77n, confirmations: 3 });
    expect(await at(status({ confirmationStatus: "finalized", confirmations: null }))).toEqual({ status: "final", slotOrBlock: 77n });
    expect((await at(status({ err: { InstructionError: [1, { Custom: 1 }] } }))).status).toBe("failed");
  });

  it("calls a missing transaction pending until its blockhash is past, then expired", async () => {
    const pending = new SolanaObservationAdapter({ network: "solana-devnet", rpc: fakeRpc({ getBlockHeight: async () => 1_000n }) });
    expect(await pending.observe(target)).toEqual({ status: "pending" });
    const expired = new SolanaObservationAdapter({ network: "solana-devnet", rpc: fakeRpc({ getBlockHeight: async () => 1_001n }) });
    expect(await expired.observe(target)).toEqual({ status: "expired" });
    // Landed just before expiry: the second look finds it.
    let calls = 0;
    const late = new SolanaObservationAdapter({
      network: "solana-devnet",
      rpc: fakeRpc({ getBlockHeight: async () => 1_001n, getSignatureStatus: async () => (++calls === 1 ? null : status({ confirmationStatus: "finalized" })) }),
    });
    expect((await late.observe(target)).status).toBe("final");
  });

  it("re-sends safely and tells definitive refusals apart", async () => {
    const prepared = { network: "solana-devnet" as const, txRef: "sig", wire: "AA==", validity: {}, fees: {}, summary: {} };
    const rpc = fakeRpc();
    const a = new SolanaObservationAdapter({ network: "solana-devnet", rpc });
    await a.submit(prepared);
    await a.submit(prepared);
    expect(rpc.sent).toEqual(["AA==", "AA=="]);

    const processed = new SolanaObservationAdapter({ network: "solana-devnet", rpc: fakeRpc({ sendTransaction: async () => Promise.reject(new SolanaRpcError(-32002, "This transaction has already been processed")) }) });
    await expect(processed.submit(prepared)).resolves.toBeUndefined();

    const sim = new SolanaObservationAdapter({ network: "solana-devnet", rpc: fakeRpc({ sendTransaction: async () => Promise.reject(new SolanaRpcError(-32002, "Transaction simulation failed: custom program error: 0x11")) }) });
    await expect(sim.submit(prepared)).rejects.toMatchObject({ definitive: true });

    const flaky = new SolanaObservationAdapter({ network: "solana-devnet", rpc: fakeRpc({ sendTransaction: async () => Promise.reject(new Error("ECONNRESET")) }) });
    await expect(flaky.submit(prepared)).rejects.toBeInstanceOf(SolanaSubmitError);
    await expect(flaky.submit(prepared)).rejects.toMatchObject({ definitive: false });
  });
});

describe("JSON-RPC client", () => {
  it("sends the right calls and parses results", async () => {
    const { httpSolanaRpc } = await import("./rpc");
    const calls: { method: string; params: unknown[] }[] = [];
    const results: Record<string, unknown> = {
      getLatestBlockhash: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1234 } },
      getSignatureStatuses: { context: { slot: 1 }, value: [{ slot: 9, confirmations: null, err: null, confirmationStatus: "finalized" }] },
      sendTransaction: "5ig",
    };
    const rpc = httpSolanaRpc("https://rpc.example", async (_url, init) => {
      const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: body.method, params: body.params });
      if (body.method === "getBlockHeight") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "Node is behind" } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: results[body.method] }) };
    });
    expect(await rpc.getLatestBlockhash()).toEqual({ blockhash: BLOCKHASH, lastValidBlockHeight: 1234n });
    expect(await rpc.getSignatureStatus("abc")).toEqual({ slot: 9n, confirmations: null, err: null, confirmationStatus: "finalized" });
    expect(await rpc.sendTransaction("AA==")).toBe("5ig");
    await expect(rpc.getBlockHeight()).rejects.toMatchObject({ code: -32005 });
    expect(calls.find((c) => c.method === "sendTransaction")!.params[1]).toMatchObject({ encoding: "base64", maxRetries: 0, skipPreflight: false });
    expect(calls.find((c) => c.method === "getSignatureStatuses")!.params[1]).toEqual({ searchTransactionHistory: true });
  });
});
