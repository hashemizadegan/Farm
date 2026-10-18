/**
 * Our dependency-light Solana encoding, checked against the reference SDKs (dev-only dependencies):
 * addresses, program-derived addresses, instruction bytes, mint sizes and whole signed transactions.
 */
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createFreezeAccountInstruction,
  createInitializeMint2Instruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMintToCheckedInstruction,
  createThawAccountInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "./base58";
import { compileMessage, signAndSerialize, type Instruction } from "./codec";
import * as ix from "./instructions";
import { associatedTokenAddress, findProgramAddress } from "./keys";

const key = () => Keypair.generate().publicKey;
const s = (p: PublicKey) => p.toBase58();

function same(ours: Instruction, ref: TransactionInstruction) {
  expect(ours.programId).toBe(ref.programId.toBase58());
  expect(Buffer.from(ours.data).toString("hex")).toBe(Buffer.from(ref.data).toString("hex"));
  expect(ours.accounts).toEqual(ref.keys.map((k) => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })));
}

describe("Solana encoding matches the reference SDKs", () => {
  it("encodes base58 like PublicKey", () => {
    for (let i = 0; i < 20; i++) {
      const pk = key();
      expect(base58Encode(pk.toBytes())).toBe(pk.toBase58());
      expect(Buffer.from(base58Decode(pk.toBase58())).equals(Buffer.from(pk.toBytes()))).toBe(true);
    }
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  it("derives program and associated token addresses", () => {
    for (let i = 0; i < 10; i++) {
      const owner = key();
      const mint = key();
      expect(associatedTokenAddress(s(owner), s(mint))).toBe(getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID).toBase58());
      const seed = Buffer.from(`seed-${i}`);
      const [refAddr, refBump] = PublicKey.findProgramAddressSync([seed], TOKEN_2022_PROGRAM_ID);
      expect(findProgramAddress([seed], TOKEN_2022_PROGRAM_ID.toBase58())).toEqual([refAddr.toBase58(), refBump]);
    }
  });

  it("builds Token-2022 instructions byte for byte", () => {
    const [mint, a, b, c, hook] = [key(), key(), key(), key(), key()];
    same(ix.initializeMint2({ mint: s(mint), decimals: 6, mintAuthority: s(a), freezeAuthority: s(b) }), createInitializeMint2Instruction(mint, 6, a, b, TOKEN_2022_PROGRAM_ID));
    same(ix.initializeMint2({ mint: s(mint), decimals: 0, mintAuthority: s(a), freezeAuthority: null }), createInitializeMint2Instruction(mint, 0, a, null, TOKEN_2022_PROGRAM_ID));
    same(
      ix.initializeTransferFeeConfig({ mint: s(mint), configAuthority: s(a), withdrawAuthority: s(b), basisPoints: 50, maximumFee: 5_000_000n }),
      createInitializeTransferFeeConfigInstruction(mint, a, b, 50, 5_000_000n, TOKEN_2022_PROGRAM_ID),
    );
    // An absent authority is one zero byte, so the next option is read from the right place.
    const noConfig = ix.initializeTransferFeeConfig({ mint: s(mint), configAuthority: null, withdrawAuthority: s(b), basisPoints: 1, maximumFee: 1n });
    expect(Buffer.from(noConfig.data.subarray(0, 4)).toString("hex")).toBe("1a000001");
    expect(noConfig.data).toHaveLength(2 + 1 + 33 + 2 + 8);
    same(ix.initializePermanentDelegate({ mint: s(mint), delegate: s(c) }), createInitializePermanentDelegateInstruction(mint, c, TOKEN_2022_PROGRAM_ID));
    same(ix.initializeTransferHook({ mint: s(mint), authority: s(a), programId: s(hook) }), createInitializeTransferHookInstruction(mint, a, hook, TOKEN_2022_PROGRAM_ID));
    same(ix.mintToChecked({ mint: s(mint), destination: s(b), authority: s(a), amount: 1_000_000n, decimals: 6 }), createMintToCheckedInstruction(mint, b, a, 1_000_000n, 6, [], TOKEN_2022_PROGRAM_ID));
    same(ix.burnChecked({ account: s(b), mint: s(mint), authority: s(a), amount: 42n, decimals: 6 }), createBurnCheckedInstruction(b, mint, a, 42n, 6, [], TOKEN_2022_PROGRAM_ID));
    same(ix.freezeAccount({ account: s(b), mint: s(mint), authority: s(a) }), createFreezeAccountInstruction(b, mint, a, [], TOKEN_2022_PROGRAM_ID));
    same(ix.thawAccount({ account: s(b), mint: s(mint), authority: s(a) }), createThawAccountInstruction(b, mint, a, [], TOKEN_2022_PROGRAM_ID));
    same(
      ix.createAssociatedTokenAccountIdempotent({ payer: s(a), ata: s(b), owner: s(c), mint: s(mint) }),
      createAssociatedTokenAccountIdempotentInstruction(a, b, c, mint, TOKEN_2022_PROGRAM_ID),
    );
  });

  it("builds system and compute-budget instructions byte for byte", () => {
    const [from, to, owner] = [key(), key(), key()];
    same(
      ix.createAccount({ from: s(from), newAccount: s(to), lamports: 1_461_600n, space: 82, owner: s(owner) }),
      SystemProgram.createAccount({ fromPubkey: from, newAccountPubkey: to, lamports: 1_461_600, space: 82, programId: owner }),
    );
    same(ix.setComputeUnitLimit(200_000), ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    same(ix.setComputeUnitPrice(12_345n), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345n }));
  });

  it("sizes mints like getMintLen", () => {
    const map = { transferFeeConfig: ExtensionType.TransferFeeConfig, permanentDelegate: ExtensionType.PermanentDelegate, transferHook: ExtensionType.TransferHook } as const;
    const all: ix.MintExtension[][] = [[], ["transferFeeConfig"], ["permanentDelegate"], ["transferHook"], ["transferFeeConfig", "permanentDelegate"], ["transferFeeConfig", "permanentDelegate", "transferHook"]];
    for (const e of all) expect(ix.mintLength(e)).toBe(getMintLen(e.map((x) => map[x])));
  });

  it("produces transactions the reference SDK decodes and verifies", async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const holder = key();
    const blockhash = s(key());
    const instructions = [
      ix.setComputeUnitLimit(100_000),
      ix.createAccount({ from: payer.publicKey.toBase58(), newAccount: mint.publicKey.toBase58(), lamports: 2_000_000n, space: 82, owner: TOKEN_2022_PROGRAM_ID.toBase58() }),
      ix.initializeMint2({ mint: mint.publicKey.toBase58(), decimals: 6, mintAuthority: payer.publicKey.toBase58(), freezeAuthority: null }),
      ix.mintToChecked({ mint: mint.publicKey.toBase58(), destination: s(holder), authority: payer.publicKey.toBase58(), amount: 5n, decimals: 6 }),
    ];
    const compiled = compileMessage(payer.publicKey.toBase58(), blockhash, instructions);
    const signWith = (kp: Keypair) => async (m: Uint8Array) => ed25519.sign(m, kp.secretKey.slice(0, 32));
    const { wire, signature } = await signAndSerialize(
      compiled,
      new Map([
        [payer.publicKey.toBase58(), signWith(payer)],
        [mint.publicKey.toBase58(), signWith(mint)],
      ]),
    );
    const tx = Transaction.from(Buffer.from(wire));
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.toBase58()).toBe(payer.publicKey.toBase58());
    expect(tx.recentBlockhash).toBe(blockhash);
    expect(base58Encode(tx.signature!)).toBe(signature);
    expect(tx.instructions.map((i) => Buffer.from(i.data).toString("hex"))).toEqual(instructions.map((i) => Buffer.from(i.data).toString("hex")));
    // Decoded flags are per message (an account writable anywhere is writable everywhere), so compare addresses.
    expect(tx.instructions.map((i) => i.keys.map((k) => k.pubkey.toBase58()))).toEqual(instructions.map((i) => i.accounts.map((a) => a.address)));
  });
});
