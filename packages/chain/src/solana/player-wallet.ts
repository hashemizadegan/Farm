/**
 * J8: proof that a player controls a Solana wallet, for linking it to their platform account.
 *
 * The server issues a one-time, human-readable message (in the style of Sign-In With Solana). The
 * player signs it in their own wallet (`signMessage`, an off-chain signature over these exact UTF-8
 * bytes), and the server checks that signature with the wallet's public key. The platform holds no key
 * and signs nothing. The message is not a transaction and authorises nothing on chain; it says so.
 *
 * Linking a player wallet is not an RWA party-wallet association, and the message says that too.
 */
import { createPublicKey, verify } from "node:crypto";
import { base58Decode } from "./base58";

export const PLAYER_WALLET_LINK_STATEMENT =
  "Link this wallet to your player account. This signature does not authorise any transaction or transfer, and does not register the wallet with any investor (real-world asset) account.";

export interface PlayerWalletLinkMessage {
  /** The web app's host, e.g. app.example.com. */
  domain: string;
  address: string;
  /** The web app's origin, e.g. https://app.example.com. */
  uri: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

const ONE_LINE = /^[^\r\n]+$/;

/** The exact text the player signs. Every field is one line, so the message cannot be reshaped. */
export function buildPlayerWalletLinkMessage(m: PlayerWalletLinkMessage): string {
  for (const [k, v] of Object.entries({ domain: m.domain, address: m.address, uri: m.uri, nonce: m.nonce })) {
    if (!ONE_LINE.test(v)) throw new Error(`${k} must be a single non-empty line`);
  }
  return [
    `${m.domain} wants you to sign in with your Solana account:`,
    m.address,
    "",
    PLAYER_WALLET_LINK_STATEMENT,
    "",
    `URI: ${m.uri}`,
    "Version: 1",
    `Nonce: ${m.nonce}`,
    `Issued At: ${m.issuedAt.toISOString()}`,
    `Expiration Time: ${m.expiresAt.toISOString()}`,
  ].join("\n");
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32-byte key follows.
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

/**
 * Whether `signature` (64 bytes) is the Ed25519 signature of `message` (its UTF-8 bytes) by the key
 * that is `address`. Never throws: malformed input is simply not a valid signature.
 */
export function verifyPlayerWalletSignature(message: string, address: string, signature: Uint8Array): boolean {
  try {
    if (signature.length !== 64) return false;
    const key = base58Decode(address);
    if (key.length !== 32) return false;
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
    spki.set(ED25519_SPKI_PREFIX);
    spki.set(key, ED25519_SPKI_PREFIX.length);
    const publicKey = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}
