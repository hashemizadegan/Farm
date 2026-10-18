/**
 * In-process signers for devnet and testnets only. Keys come from secrets the operator sets on
 * the platform; production signing goes through a KMS/HSM adapter behind the same interfaces.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { MAINNETS, type Ed25519Signer, type Network, type TronSigner } from "@metafarm/domain";
import { concatBytes, fromHex, toHex } from "./bytes";
import { base58Decode, base58Encode } from "./solana/base58";
import { tronAddressOfPublicKey } from "./tron/address";

function testnetOnly(network: Network) {
  if (MAINNETS.includes(network)) throw new Error(`in-process keys are refused on ${network}; use a KMS/HSM signer`);
}

/** From a base58 secret: 64 bytes (seed ‖ public key, the Solana CLI keypair format) or a 32-byte seed. */
export function localEd25519Signer(secretBase58: string, network: Network): Ed25519Signer {
  testnetOnly(network);
  const raw = base58Decode(secretBase58);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("a Solana secret is 32 or 64 bytes");
  const seed = raw.subarray(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (raw.length === 64 && toHex(raw.subarray(32)) !== toHex(publicKey)) throw new Error("the secret's public half does not match its seed");
  return { address: base58Encode(publicKey), signMessage: async (m) => ed25519.sign(m, seed) };
}

/** From a 32-byte hex private key. Signatures are r‖s‖v with v = 27 + recovery, as TRON expects. */
export function localTronSigner(privateKeyHex: string, network: Network): TronSigner {
  testnetOnly(network);
  const key = fromHex(privateKeyHex);
  if (key.length !== 32) throw new Error("a TRON private key is 32 bytes");
  return {
    address: tronAddressOfPublicKey(secp256k1.getPublicKey(key, false)),
    signTransactionId: async (txId) => {
      const sig = secp256k1.sign(fromHex(txId), key);
      return toHex(concatBytes(sig.toCompactRawBytes(), Uint8Array.of(27 + sig.recovery)));
    },
  };
}
