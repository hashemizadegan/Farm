/** AssetIssuancePort on Solana Token-2022: create share mints and mint, burn, freeze or thaw holdings. */
import {
  networkAllowed,
  railOf,
  type AssetIssuancePort,
  type CreateMintRequest,
  type Ed25519Signer,
  type IssuanceRequest,
  type Network,
  type PreparedTransaction,
} from "@metafarm/domain";
import { U64_MAX, toBase64 } from "../bytes";
import { compileMessage, signAndSerialize, type Instruction, type SignFn } from "./codec";
import {
  burnChecked,
  createAccount,
  createAssociatedTokenAccountIdempotent,
  freezeAccount,
  initializeMint2,
  initializePermanentDelegate,
  initializeTransferFeeConfig,
  initializeTransferHook,
  mintLength,
  mintToChecked,
  setComputeUnitLimit,
  setComputeUnitPrice,
  thawAccount,
  type MintExtension,
} from "./instructions";
import { TOKEN_2022_PROGRAM, associatedTokenAddress, ephemeralKeypair, isSolanaAddress } from "./keys";
import type { SolanaRpc } from "./rpc";

export interface SolanaAdapterConfig {
  network: Network;
  rpc: SolanaRpc;
  /** Fee payer and the authority (mint, freeze, permanent delegate) for the actions it signs. */
  signer: Ed25519Signer;
  mainnetEnabled: boolean;
  computeUnitLimit?: number;
  /** Ceiling on the priority fee whatever the market says (micro-lamports per compute unit). */
  maxPriorityFeeMicroLamports?: bigint;
  /** For tests: deterministic mint keys. */
  random?: (n: number) => Uint8Array;
}

/** The 75th percentile of recent non-zero fees, capped. Zero when the network is quiet. */
export function choosePriorityFee(recent: bigint[], cap: bigint): bigint {
  const paid = recent.filter((f) => f > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paid.length === 0) return 0n;
  const p75 = paid[Math.min(paid.length - 1, Math.floor(paid.length * 0.75))]!;
  return p75 > cap ? cap : p75;
}

export class SolanaToken2022Adapter implements AssetIssuancePort {
  private readonly cuLimit: number;
  private readonly feeCap: bigint;

  constructor(private readonly cfg: SolanaAdapterConfig) {
    if (railOf(cfg.network) !== "solana") throw new Error(`${cfg.network} is not a Solana network`);
    if (!networkAllowed(cfg.network, { mainnetEnabled: cfg.mainnetEnabled })) throw new Error(`${cfg.network} is not enabled for issuance`);
    this.cuLimit = cfg.computeUnitLimit ?? 200_000;
    this.feeCap = cfg.maxPriorityFeeMicroLamports ?? 1_000_000n;
  }

  async prepareCreateMint(r: CreateMintRequest): Promise<PreparedTransaction & { mintAddress: string }> {
    this.checkNetwork(r.network);
    for (const a of [r.mintAuthority, r.freezeAuthority, r.transferHookProgramId, r.transferHookAuthority, r.permanentDelegate, r.transferFee?.configAuthority, r.transferFee?.withdrawAuthority]) {
      if (a && !isSolanaAddress(a)) throw new Error(`not a Solana address: ${a}`);
    }
    const mint = ephemeralKeypair(this.cfg.random);
    const extensions: MintExtension[] = [];
    const init: Instruction[] = [];
    if (r.transferFee) {
      extensions.push("transferFeeConfig");
      init.push(
        initializeTransferFeeConfig({
          mint: mint.address,
          configAuthority: r.transferFee.configAuthority,
          withdrawAuthority: r.transferFee.withdrawAuthority,
          basisPoints: r.transferFee.basisPoints,
          maximumFee: r.transferFee.maximumFee,
        }),
      );
    }
    if (r.permanentDelegate) {
      extensions.push("permanentDelegate");
      init.push(initializePermanentDelegate({ mint: mint.address, delegate: r.permanentDelegate }));
    }
    if (r.transferHookProgramId) {
      extensions.push("transferHook");
      init.push(initializeTransferHook({ mint: mint.address, authority: r.transferHookAuthority ?? null, programId: r.transferHookProgramId }));
    }
    const space = mintLength(extensions);
    const lamports = await this.cfg.rpc.getMinimumBalanceForRentExemption(space);
    const instructions = [
      createAccount({ from: this.cfg.signer.address, newAccount: mint.address, lamports, space, owner: TOKEN_2022_PROGRAM }),
      // Extensions are initialised before the mint itself.
      ...init,
      initializeMint2({ mint: mint.address, decimals: r.decimals, mintAuthority: r.mintAuthority, freezeAuthority: r.freezeAuthority }),
    ];
    const prepared = await this.finish(instructions, [mint.address], new Map([[mint.address, mint.sign]]), {
      action: "create_mint",
      mint: mint.address,
      decimals: r.decimals,
      extensions,
      rentLamports: lamports.toString(),
    });
    return { ...prepared, mintAddress: mint.address };
  }

  async prepareIssuance(r: IssuanceRequest): Promise<PreparedTransaction> {
    this.checkNetwork(r.network);
    if (!isSolanaAddress(r.mintAddress) || !isSolanaAddress(r.holderAddress)) throw new Error("mint and holder must be Solana addresses");
    const me = this.cfg.signer.address;
    const ata = associatedTokenAddress(r.holderAddress, r.mintAddress);
    const amount = () => {
      if (r.amount === undefined || r.amount <= 0n || r.amount > U64_MAX) throw new RangeError("amount must be between 1 and 2^64-1 base units");
      return r.amount;
    };
    let instructions: Instruction[];
    switch (r.action) {
      case "mint":
        instructions = [
          createAssociatedTokenAccountIdempotent({ payer: me, ata, owner: r.holderAddress, mint: r.mintAddress }),
          mintToChecked({ mint: r.mintAddress, destination: ata, authority: me, amount: amount(), decimals: r.decimals }),
        ];
        break;
      case "burn":
        // Signed by the holder's delegate: the mint's permanent delegate for redemptions.
        instructions = [burnChecked({ account: ata, mint: r.mintAddress, authority: me, amount: amount(), decimals: r.decimals })];
        break;
      case "freeze":
        instructions = [freezeAccount({ account: ata, mint: r.mintAddress, authority: me })];
        break;
      case "thaw":
        instructions = [thawAccount({ account: ata, mint: r.mintAddress, authority: me })];
        break;
    }
    return this.finish(instructions, [ata, r.mintAddress], new Map(), {
      action: r.action,
      mint: r.mintAddress,
      holder: r.holderAddress,
      tokenAccount: ata,
      amount: r.amount?.toString() ?? null,
    });
  }

  private checkNetwork(network: Network) {
    if (network !== this.cfg.network) throw new Error(`this adapter serves ${this.cfg.network}, not ${network}`);
  }

  private async finish(body: Instruction[], writable: string[], extraSigners: Map<string, SignFn>, summary: Record<string, unknown>): Promise<PreparedTransaction> {
    const fee = choosePriorityFee(await this.cfg.rpc.getRecentPrioritizationFees(writable), this.feeCap);
    const instructions = [setComputeUnitLimit(this.cuLimit), ...(fee > 0n ? [setComputeUnitPrice(fee)] : []), ...body];
    const { blockhash, lastValidBlockHeight } = await this.cfg.rpc.getLatestBlockhash();
    const compiled = compileMessage(this.cfg.signer.address, blockhash, instructions);
    const signers = new Map<string, SignFn>([[this.cfg.signer.address, (m) => this.cfg.signer.signMessage(m)], ...extraSigners]);
    const { wire, signature } = await signAndSerialize(compiled, signers);
    return {
      network: this.cfg.network,
      txRef: signature,
      wire: toBase64(wire),
      validity: { lastValidBlockHeight },
      fees: { priorityFeeMicroLamports: fee, computeUnitLimit: this.cuLimit },
      summary: { ...summary, feePayer: this.cfg.signer.address, recentBlockhash: blockhash },
    };
  }
}
