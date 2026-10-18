/** Our Bubblegum encoding against @metaplex-foundation/mpl-bubblegum (a dev-only dependency). */
import {
  DecompressibleState,
  TokenProgramVersion,
  TokenStandard,
  Version,
  getCreateTreeConfigInstructionDataSerializer,
  getLeafSchemaSerializer,
  getMetadataArgsSerializer,
  getMintV1InstructionDataSerializer,
  getTreeConfigAccountDataSerializer,
  hashMetadataCreators,
  hashMetadataData,
  type MetadataArgsArgs,
} from "@metaplex-foundation/mpl-bubblegum";
import { none, publicKey, some } from "@metaplex-foundation/umi";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { concatBytes, toHex, u32le, u64le } from "../bytes";
import { base58Decode, base58Encode } from "./base58";
import {
  BUBBLEGUM_PROGRAM,
  createTreeConfig,
  encodeMetadataArgs,
  leafAssetId,
  metadataHashes,
  mintV1,
  parseLeafEvent,
  parseTreeConfig,
  treeConfigAddress,
  type CompressedMetadata,
} from "./bubblegum";

const key = () => Keypair.generate().publicKey.toBase58();
const hex = (b: Uint8Array | number[]) => toHex(Uint8Array.from(b));

function sample(o: Partial<CompressedMetadata> = {}): CompressedMetadata {
  return {
    name: "Olive tree #1042",
    symbol: "TREE",
    uri: "https://example.org/assets/1042.json",
    sellerFeeBasisPoints: 0,
    primarySaleHappened: false,
    isMutable: true,
    creators: [{ address: key(), verified: true, share: 100 }],
    ...o,
  };
}

const theirs = (m: CompressedMetadata): MetadataArgsArgs => ({
  name: m.name,
  symbol: m.symbol,
  uri: m.uri,
  sellerFeeBasisPoints: m.sellerFeeBasisPoints,
  primarySaleHappened: m.primarySaleHappened,
  isMutable: m.isMutable,
  editionNonce: none(),
  tokenStandard: some(TokenStandard.NonFungible),
  collection: none(),
  uses: none(),
  tokenProgramVersion: TokenProgramVersion.Original,
  creators: m.creators.map((c) => ({ address: publicKey(c.address), verified: c.verified, share: c.share })),
});

describe("Bubblegum encoding matches mpl-bubblegum", () => {
  it("derives tree config and asset ids like the program", () => {
    for (let i = 0; i < 5; i++) {
      const tree = key();
      const program = new PublicKey(BUBBLEGUM_PROGRAM);
      expect(treeConfigAddress(tree)).toBe(PublicKey.findProgramAddressSync([new PublicKey(tree).toBuffer()], program)[0].toBase58());
      for (const index of [0n, 1n, 65_535n, (1n << 40n) + 7n]) {
        const ref = PublicKey.findProgramAddressSync([Buffer.from("asset"), new PublicKey(tree).toBuffer(), Buffer.from(u64le(index))], program)[0];
        expect(leafAssetId(tree, index)).toBe(ref.toBase58());
      }
    }
  });

  it("encodes MetadataArgs and the mint instruction byte for byte", () => {
    const cases = [
      sample(),
      sample({ name: "Parcel B-7 · زیتون", symbol: "", uri: "", isMutable: false, primarySaleHappened: true, sellerFeeBasisPoints: 250 }),
      sample({ creators: [] }),
      sample({ creators: [{ address: key(), verified: false, share: 40 }, { address: key(), verified: true, share: 60 }] }),
    ];
    for (const m of cases) {
      expect(hex(encodeMetadataArgs(m))).toBe(hex(getMetadataArgsSerializer().serialize(theirs(m))));
      const ix = mintV1({ merkleTree: key(), leafOwner: key(), payer: key(), treeDelegate: key(), metadata: m });
      expect(hex(ix.data)).toBe(hex(getMintV1InstructionDataSerializer().serialize({ metadata: theirs(m) })));
      const { dataHash, creatorHash } = metadataHashes(m);
      expect(hex(dataHash)).toBe(hex(hashMetadataData(theirs(m))));
      expect(hex(creatorHash)).toBe(hex(hashMetadataCreators(theirs(m).creators)));
    }
  });

  it("encodes create_tree_config byte for byte", () => {
    for (const [maxDepth, maxBufferSize, pub] of [[14, 64, false], [20, 256, true], [3, 8, undefined]] as const) {
      const ix = createTreeConfig({ merkleTree: key(), payer: key(), treeCreator: key(), maxDepth, maxBufferSize, public: pub });
      expect(hex(ix.data)).toBe(hex(getCreateTreeConfigInstructionDataSerializer().serialize({ maxDepth, maxBufferSize, public: pub === undefined ? none() : some(pub) })));
    }
  });

  it("reads tree config accounts the program writes", () => {
    const creator = key();
    const delegate = key();
    const bytes = getTreeConfigAccountDataSerializer().serialize({
      treeCreator: publicKey(creator),
      treeDelegate: publicKey(delegate),
      totalMintCapacity: 16_384n,
      numMinted: 42n,
      isPublic: false,
      isDecompressible: DecompressibleState.Disabled,
      version: Version.V1,
    });
    expect(parseTreeConfig(bytes)).toEqual({ treeCreator: creator, treeDelegate: delegate, totalMintCapacity: 16_384n, numMinted: 42n, isPublic: false });
    expect(() => parseTreeConfig(new Uint8Array(100))).toThrow(/not a Bubblegum tree config/);
  });

  it("reads the leaf a mint appended from its noop event", () => {
    const [id, owner, delegate] = [key(), key(), key()];
    const dataHash = base58Decode(key());
    const creatorHash = base58Decode(key());
    const leafHash = base58Decode(key());
    const schema = getLeafSchemaSerializer().serialize({ __kind: "V1", id: publicKey(id), owner: publicKey(owner), delegate: publicKey(delegate), nonce: 9n, dataHash, creatorHash });
    // LeafSchemaEvent { event type: LeafSchemaEvent (1), version: V1 (0), schema, leaf hash }.
    const event = concatBytes(Uint8Array.of(1, 0), schema, leafHash);
    // AccountCompressionEvent::ApplicationData(ApplicationDataEvent::V1 { application_data }).
    const data = concatBytes(Uint8Array.of(1, 0), u32le(event.length), event);
    expect(parseLeafEvent(data)).toEqual({
      assetId: id,
      owner,
      delegate,
      nonce: 9n,
      dataHash: base58Encode(dataHash),
      creatorHash: base58Encode(creatorHash),
      leafHash: base58Encode(leafHash),
    });
    expect(() => parseLeafEvent(Uint8Array.of(0, 0))).toThrow(/not an application data event/);
  });
});
