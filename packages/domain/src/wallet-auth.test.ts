import { describe, expect, it } from "vitest";
import {
  WALLET_LINK_STATEMENT,
  WalletAuthError,
  buildWalletAuthMessage,
  parseWalletAuthMessage,
  verifyWalletAuth,
  type WalletVerificationContext,
} from "./wallet-auth";

const address = "0x1111111111111111111111111111111111111111";
const now = new Date("2026-03-01T12:00:00Z");
const base = {
  domain: "app.example.com",
  address,
  statement: WALLET_LINK_STATEMENT,
  uri: "https://app.example.com",
  version: "1" as const,
  chainId: 1,
  nonce: "abcdefghijklmnop1234",
  issuedAt: "2026-03-01T11:59:00Z",
  expirationTime: "2026-03-01T12:04:00Z",
};

const ctx = (over: Partial<WalletVerificationContext> = {}): WalletVerificationContext => ({
  expectedDomain: base.domain,
  expectedUri: base.uri,
  allowedChainIds: [1],
  expectedNonce: base.nonce,
  now,
  maxAgeSeconds: 300,
  recoverAddress: async () => address,
  ...over,
});

const sig = `0x${"ab".repeat(65)}` as const;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof WalletAuthError ? e.code : "other";
  }
}

describe("wallet auth", () => {
  it("round-trips the message format", () => {
    expect(parseWalletAuthMessage(buildWalletAuthMessage(base))).toEqual(base);
  });

  it("accepts a valid message", async () => {
    expect(await code(verifyWalletAuth(buildWalletAuthMessage(base), sig, ctx()))).toBe("ok");
  });

  it("rejects a wrong domain (phishing site)", async () => {
    const m = buildWalletAuthMessage({ ...base, domain: "evil.example" });
    expect(await code(verifyWalletAuth(m, sig, ctx()))).toBe("DOMAIN_MISMATCH");
  });

  it("rejects a disallowed chain", async () => {
    const m = buildWalletAuthMessage({ ...base, chainId: 5 });
    expect(await code(verifyWalletAuth(m, sig, ctx()))).toBe("CHAIN_NOT_ALLOWED");
  });

  it("rejects a replayed nonce (none outstanding)", async () => {
    expect(await code(verifyWalletAuth(buildWalletAuthMessage(base), sig, ctx({ expectedNonce: undefined })))).toBe(
      "NONCE_MISMATCH",
    );
  });

  it("rejects expired messages", async () => {
    expect(
      await code(verifyWalletAuth(buildWalletAuthMessage(base), sig, ctx({ now: new Date("2026-03-01T12:10:00Z") }))),
    ).toBe("EXPIRED");
  });

  it("rejects messages issued in the future", async () => {
    const m = buildWalletAuthMessage({ ...base, issuedAt: "2026-03-01T12:05:00Z", expirationTime: "2026-03-01T12:06:00Z" });
    expect(await code(verifyWalletAuth(m, sig, ctx()))).toBe("NOT_YET_VALID");
  });

  it("rejects over-long validity windows", async () => {
    const m = buildWalletAuthMessage({ ...base, expirationTime: "2026-03-02T12:00:00Z" });
    expect(await code(verifyWalletAuth(m, sig, ctx()))).toBe("MALFORMED");
  });

  it("rejects a signature from a different address", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    expect(
      await code(verifyWalletAuth(buildWalletAuthMessage(base), sig, ctx({ recoverAddress: async () => other }))),
    ).toBe("BAD_SIGNATURE");
  });

  it("rejects malformed messages", async () => {
    expect(await code(verifyWalletAuth("hello", sig, ctx()))).toBe("MALFORMED");
  });
});
