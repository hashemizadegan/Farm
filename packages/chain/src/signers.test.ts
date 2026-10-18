import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { concatBytes, toHex, utf8 } from "./bytes";
import { localEd25519Signer, localTronSigner } from "./signers";
import { base58Encode } from "./solana/base58";
import { parseMintAccount } from "./solana/mint-account";
import { recoverTronSigner, tronAddressToHex } from "./tron/address";

describe("testnet signers", () => {
  it("signs Solana messages with a CLI keypair or a seed", async () => {
    const kp = Keypair.generate();
    const fromCli = localEd25519Signer(base58Encode(kp.secretKey), "solana-devnet");
    expect(fromCli.address).toBe(kp.publicKey.toBase58());
    const sig = await fromCli.signMessage(utf8("hello"));
    expect(ed25519.verify(sig, utf8("hello"), kp.publicKey.toBytes())).toBe(true);
    expect(localEd25519Signer(base58Encode(kp.secretKey.slice(0, 32)), "solana-devnet").address).toBe(fromCli.address);
    const tampered = concatBytes(kp.secretKey.slice(0, 32), new Uint8Array(32).fill(1));
    expect(() => localEd25519Signer(base58Encode(tampered), "solana-devnet")).toThrow(/does not match/);
  });

  it("signs TRON transaction ids recoverably", async () => {
    const s = localTronSigner("00".repeat(31) + "01", "tron-nile");
    expect(tronAddressToHex(s.address)).toBe("417e5f4552091a69125d5dfcb7b8c2659029395bdf");
    const txId = "ab".repeat(32);
    expect(recoverTronSigner(txId, await s.signTransactionId(txId))).toBe(s.address);
  });

  it("refuses mainnets", () => {
    expect(() => localEd25519Signer(base58Encode(new Uint8Array(32).fill(1)), "solana-mainnet")).toThrow(/refused on solana-mainnet/);
    expect(() => localTronSigner("11".repeat(32), "tron-mainnet")).toThrow(/refused on tron-mainnet/);
  });
});

describe("mint accounts", () => {
  it("reads authorities, supply and decimals", () => {
    const auth = new Uint8Array(32).fill(7);
    const data = new Uint8Array(82);
    const v = new DataView(data.buffer);
    v.setUint32(0, 1, true);
    data.set(auth, 4);
    v.setBigUint64(36, 1_000_000n, true);
    data[44] = 6;
    data[45] = 1;
    expect(parseMintAccount(data)).toEqual({ mintAuthority: base58Encode(auth), supply: 1_000_000n, decimals: 6, initialized: true, freezeAuthority: null });
    expect(() => parseMintAccount(new Uint8Array(10))).toThrow();
    expect(toHex(data.subarray(0, 4))).toBe("01000000");
  });
});
