import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Encode } from "./base58";
import { PLAYER_WALLET_LINK_STATEMENT, buildPlayerWalletLinkMessage, verifyPlayerWalletSignature } from "./player-wallet";

/** A wallet as the tests need it: its address and a signMessage over the exact bytes. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { address: base58Encode(new Uint8Array(raw)), signMessage: (m: string) => new Uint8Array(sign(null, Buffer.from(m, "utf8"), privateKey)) };
}

const at = new Date("2026-10-21T08:00:00.000Z");
const message = (address: string, nonce = "n0nce-0123456789abcdef") =>
  buildPlayerWalletLinkMessage({ domain: "app.example.com", address, uri: "https://app.example.com", nonce, issuedAt: at, expiresAt: new Date(at.getTime() + 300_000) });

describe("player wallet link message", () => {
  it("is the documented text, and says it authorises nothing and is not an RWA association", () => {
    const m = message("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(m).toBe(
      [
        "app.example.com wants you to sign in with your Solana account:",
        "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        "",
        PLAYER_WALLET_LINK_STATEMENT,
        "",
        "URI: https://app.example.com",
        "Version: 1",
        "Nonce: n0nce-0123456789abcdef",
        "Issued At: 2026-10-21T08:00:00.000Z",
        "Expiration Time: 2026-10-21T08:05:00.000Z",
      ].join("\n"),
    );
    expect(PLAYER_WALLET_LINK_STATEMENT).toContain("does not authorise any transaction");
    expect(PLAYER_WALLET_LINK_STATEMENT).toContain("investor");
  });

  it("refuses fields that would add lines", () => {
    expect(() => message("addr\nURI: https://evil.example")).toThrow();
    expect(() => message("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "")).toThrow();
  });
});

describe("verifyPlayerWalletSignature", () => {
  it("accepts the wallet's signature of the exact message", () => {
    const w = wallet();
    const m = message(w.address);
    expect(verifyPlayerWalletSignature(m, w.address, w.signMessage(m))).toBe(true);
  });

  it("refuses another message, another key, a tampered or malformed signature, and a malformed address", () => {
    const w = wallet();
    const other = wallet();
    const m = message(w.address);
    const sig = w.signMessage(m);
    expect(verifyPlayerWalletSignature(m + " ", w.address, sig)).toBe(false);
    expect(verifyPlayerWalletSignature(message(w.address, "another-nonce-0123456"), w.address, sig)).toBe(false);
    expect(verifyPlayerWalletSignature(m, other.address, sig)).toBe(false);
    const tampered = sig.slice();
    tampered[10] = tampered[10]! ^ 1;
    expect(verifyPlayerWalletSignature(m, w.address, tampered)).toBe(false);
    expect(verifyPlayerWalletSignature(m, w.address, sig.slice(0, 63))).toBe(false);
    expect(verifyPlayerWalletSignature(m, w.address, new Uint8Array(64))).toBe(false);
    expect(verifyPlayerWalletSignature(m, "not-base58-0OIl", sig)).toBe(false);
    expect(verifyPlayerWalletSignature(m, "11111111", sig)).toBe(false);
  });
});
