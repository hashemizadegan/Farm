/**
 * Wallet sign-in message handling, following the EIP-4361 (Sign-In with
 * Ethereum) text format. Wallet linking only proves control of an address;
 * it never grants tenant permissions by itself.
 *
 * Replay protection:
 *   - the server issues a single-use nonce bound to the authenticated user,
 *   - the message must carry the expected domain, URI and an allowed chain id,
 *   - issued-at must be recent and expiration-time must be in the future,
 *   - the nonce is consumed atomically on first successful verification.
 *
 * Signature recovery is injected (viem in the API) so this module stays pure.
 */

export interface WalletAuthMessage {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export const WALLET_LINK_STATEMENT =
  "Link this wallet to your account. This signature does not authorise any transaction or transfer.";

export function buildWalletAuthMessage(m: WalletAuthMessage): string {
  return [
    `${m.domain} wants you to sign in with your Ethereum account:`,
    m.address,
    "",
    m.statement,
    "",
    `URI: ${m.uri}`,
    `Version: ${m.version}`,
    `Chain ID: ${m.chainId}`,
    `Nonce: ${m.nonce}`,
    `Issued At: ${m.issuedAt}`,
    `Expiration Time: ${m.expirationTime}`,
  ].join("\n");
}

export class WalletAuthError extends Error {
  constructor(
    public readonly code:
      | "MALFORMED"
      | "DOMAIN_MISMATCH"
      | "URI_MISMATCH"
      | "CHAIN_NOT_ALLOWED"
      | "EXPIRED"
      | "NOT_YET_VALID"
      | "NONCE_MISMATCH"
      | "BAD_SIGNATURE",
    message: string,
  ) {
    super(message);
    this.name = "WalletAuthError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^[A-Za-z0-9]{16,64}$/;

export function parseWalletAuthMessage(text: string): WalletAuthMessage {
  if (text.length > 2_000) throw new WalletAuthError("MALFORMED", "message too long");
  const lines = text.split("\n");
  const header = lines[0]?.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  const address = lines[1];
  if (!header || !address || !ADDRESS.test(address)) throw new WalletAuthError("MALFORMED", "bad header or address");
  const field = (name: string) => {
    const line = lines.find((l) => l.startsWith(`${name}: `));
    if (!line) throw new WalletAuthError("MALFORMED", `missing ${name}`);
    return line.slice(name.length + 2);
  };
  const chainId = Number(field("Chain ID"));
  const nonce = field("Nonce");
  if (!Number.isInteger(chainId) || chainId <= 0) throw new WalletAuthError("MALFORMED", "bad chain id");
  if (!NONCE.test(nonce)) throw new WalletAuthError("MALFORMED", "bad nonce");
  const version = field("Version");
  if (version !== "1") throw new WalletAuthError("MALFORMED", "unsupported version");
  return {
    domain: header[1]!,
    address,
    statement: lines[3] ?? "",
    uri: field("URI"),
    version: "1",
    chainId,
    nonce,
    issuedAt: field("Issued At"),
    expirationTime: field("Expiration Time"),
  };
}

export interface WalletVerificationContext {
  expectedDomain: string;
  expectedUri: string;
  allowedChainIds: readonly number[];
  /** The nonce the server issued to this user; undefined if none outstanding. */
  expectedNonce: string | undefined;
  now: Date;
  /** Maximum age of issued-at, in seconds. */
  maxAgeSeconds: number;
  /** Allowed clock skew, in seconds. */
  clockSkewSeconds?: number;
  recoverAddress: (message: string, signature: `0x${string}`) => Promise<string>;
}

/**
 * Validates a signed message. The caller MUST consume the nonce atomically
 * (e.g. DELETE ... RETURNING) only after this resolves, and reject the request
 * if the nonce was already consumed.
 */
export async function verifyWalletAuth(
  messageText: string,
  signature: `0x${string}`,
  ctx: WalletVerificationContext,
): Promise<WalletAuthMessage> {
  const m = parseWalletAuthMessage(messageText);
  const skew = (ctx.clockSkewSeconds ?? 30) * 1000;
  if (m.domain !== ctx.expectedDomain) throw new WalletAuthError("DOMAIN_MISMATCH", "domain does not match");
  if (m.uri !== ctx.expectedUri) throw new WalletAuthError("URI_MISMATCH", "uri does not match");
  if (!ctx.allowedChainIds.includes(m.chainId)) throw new WalletAuthError("CHAIN_NOT_ALLOWED", "chain id not allowed");
  if (!ctx.expectedNonce || m.nonce !== ctx.expectedNonce) throw new WalletAuthError("NONCE_MISMATCH", "nonce mismatch");

  const issued = Date.parse(m.issuedAt);
  const expires = Date.parse(m.expirationTime);
  if (Number.isNaN(issued) || Number.isNaN(expires)) throw new WalletAuthError("MALFORMED", "bad timestamps");
  const now = ctx.now.getTime();
  if (issued - skew > now) throw new WalletAuthError("NOT_YET_VALID", "issued in the future");
  if (now - issued > ctx.maxAgeSeconds * 1000 + skew) throw new WalletAuthError("EXPIRED", "message too old");
  if (expires + skew <= now) throw new WalletAuthError("EXPIRED", "message expired");
  if (expires - issued > ctx.maxAgeSeconds * 1000) throw new WalletAuthError("MALFORMED", "validity window too long");

  let recovered: string;
  try {
    recovered = await ctx.recoverAddress(messageText, signature);
  } catch {
    throw new WalletAuthError("BAD_SIGNATURE", "signature could not be verified");
  }
  if (recovered.toLowerCase() !== m.address.toLowerCase()) {
    throw new WalletAuthError("BAD_SIGNATURE", "signature does not match address");
  }
  return m;
}
