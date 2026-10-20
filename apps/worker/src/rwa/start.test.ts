/** Which rails the worker builds from its settings: compressed NFTs stay off unless fully configured. */
import { describe, expect, it } from "vitest";
import { base58Encode, localEd25519Signer } from "@metafarm/chain";
import { workerEnvSchema } from "@metafarm/config";
import { buildRails } from "./start";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
// A fixed, publicly known test seed (all 7s); never a real key.
const TEST_SEED = base58Encode(new Uint8Array(32).fill(7));
const RPC = "https://rpc.invalid/devnet";
const DAS = "https://das.invalid/devnet";
const rails = (env: Record<string, string>) => buildRails(workerEnvSchema.parse({ ...base, ...env }));

describe("RWA rails from settings", () => {
  it("builds nothing without a signer, whatever URLs are set", () => {
    expect(rails({})).toEqual({});
    expect(rails({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS })).toEqual({});
    expect(rails({ RWA_SOLANA_SIGNER_SECRET: TEST_SEED, RWA_SOLANA_DAS_URL: DAS })).toEqual({});
  });

  it("keeps compressed NFTs off without a DAS endpoint, leaving share tokens as they were", () => {
    const r = rails({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_SIGNER_SECRET: TEST_SEED });
    expect(r.solana?.network).toBe("solana-devnet");
    expect(r.solana?.issuance).toBeDefined();
    expect(r.solana?.compressed).toBeUndefined();
    expect(r.tron).toBeUndefined();
  });

  it("turns compressed NFTs on with a signer, an RPC and a DAS endpoint, the signer creating every tree", () => {
    const r = rails({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_SIGNER_SECRET: TEST_SEED, RWA_SOLANA_DAS_URL: DAS, RWA_CNFT_TREE_CAPACITY: "1000" });
    const c = r.solana?.compressed;
    expect(c).toBeDefined();
    expect(c!.creator).toBe(localEd25519Signer(TEST_SEED, "solana-devnet").address);
    expect(c!.treeShape.capacity).toBeGreaterThanOrEqual(1000);
    expect(2 ** c!.treeShape.maxDepth).toBe(c!.treeShape.capacity);
  });

  it("parses the compressed NFT settings as optional, with a bounded tree capacity", () => {
    const env = workerEnvSchema.parse(base);
    expect(env.RWA_SOLANA_DAS_URL).toBeUndefined();
    expect(env.RWA_CNFT_TREE_CAPACITY).toBe(16_384);
    expect(workerEnvSchema.safeParse({ ...base, RWA_CNFT_TREE_CAPACITY: "4" }).success).toBe(false);
    expect(workerEnvSchema.safeParse({ ...base, RWA_SOLANA_DAS_URL: "not a url" }).success).toBe(false);
  });
});
