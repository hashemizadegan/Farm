/**
 * J8: linking a Solana player wallet from the web app, through the Wallet Standard
 * (https://github.com/wallet-standard/wallet-standard), with no wallet library.
 *
 * Only two wallet features are ever used: `standard:connect` (to learn the account's address) and
 * `solana:signMessage` (to sign the one-time link message the API issued, an off-chain signature that
 * authorises nothing). Transaction features (`solana:signTransaction`, `solana:signAndSendTransaction`)
 * are never called: this module has no code path to them, and its tests check that.
 *
 * A player wallet belongs to the user's platform (game) identity. It is not an RWA party wallet, and
 * linking one never registers it with an investor account.
 */

export const CONNECT = "standard:connect";
export const SIGN_MESSAGE = "solana:signMessage";
/** The only wallet features this module calls. */
export const USED_FEATURES = [CONNECT, SIGN_MESSAGE] as const;

export interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}

export interface StandardWallet {
  name: string;
  icon?: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, unknown>;
}

type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> };
type SignMessageFeature = {
  signMessage: (...inputs: { account: WalletAccount; message: Uint8Array }[]) => Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
};

/** Whether a wallet can link: it supports Solana, connecting and message signing. */
export function canLink(w: StandardWallet): boolean {
  return w.chains.some((c) => c.startsWith("solana:")) && CONNECT in w.features && SIGN_MESSAGE in w.features;
}

/**
 * Finds Wallet Standard wallets in the page (browser extensions register themselves). Calls
 * `onChange` with every wallet that can link, now and whenever one registers. Returns a stop function.
 */
export function discoverWallets(win: Window, onChange: (wallets: StandardWallet[]) => void): () => void {
  const found: StandardWallet[] = [];
  const register = (...wallets: StandardWallet[]) => {
    for (const w of wallets) if (canLink(w) && !found.includes(w)) found.push(w);
    onChange([...found]);
    return () => undefined;
  };
  const api = Object.freeze({ register });
  const onRegister = (e: Event) => {
    const callback = (e as CustomEvent<(app: typeof api) => void>).detail;
    if (typeof callback === "function") callback(api);
  };
  win.addEventListener("wallet-standard:register-wallet", onRegister);
  // Wallets that loaded first are waiting for this event.
  win.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  onChange([...found]);
  return () => win.removeEventListener("wallet-standard:register-wallet", onRegister);
}

export class WalletLinkError extends Error {
  constructor(
    readonly code: "no_account" | "not_supported" | "rejected" | "message_changed",
    message: string,
  ) {
    super(message);
    this.name = "WalletLinkError";
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Proves control of a wallet to the API: connect, ask the API for the link message for that address,
 * have the wallet sign exactly that message, and send the signature back.
 */
export async function linkWallet(
  wallet: StandardWallet,
  api: {
    challenge: (address: string) => Promise<{ message: string }>;
    link: (address: string, signatureBase64: string) => Promise<void>;
  },
): Promise<string> {
  if (!canLink(wallet)) throw new WalletLinkError("not_supported", "this wallet cannot sign messages for Solana");
  const connect = wallet.features[CONNECT] as ConnectFeature;
  const signer = wallet.features[SIGN_MESSAGE] as SignMessageFeature;
  let accounts: readonly WalletAccount[];
  try {
    accounts = (await connect.connect()).accounts;
  } catch {
    throw new WalletLinkError("rejected", "the wallet did not connect");
  }
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:")) && a.features.includes(SIGN_MESSAGE)) ?? accounts[0];
  if (!account) throw new WalletLinkError("no_account", "the wallet shared no account");

  const { message } = await api.challenge(account.address);
  const bytes = new TextEncoder().encode(message);
  let result: { signedMessage: Uint8Array; signature: Uint8Array } | undefined;
  try {
    [result] = await signer.signMessage({ account, message: bytes });
  } catch {
    throw new WalletLinkError("rejected", "the wallet did not sign");
  }
  // The API checks the signature over the exact message it issued; refuse anything else up front.
  if (!result || !sameBytes(result.signedMessage, bytes)) throw new WalletLinkError("message_changed", "the wallet signed a different message");
  await api.link(account.address, toBase64(result.signature));
  return account.address;
}

/** Whether player-wallet linking is shown in this build (NEXT_PUBLIC_PLAYER_WALLETS_ENABLED, off by default). */
export const playerWalletsEnabled = () => process.env.NEXT_PUBLIC_PLAYER_WALLETS_ENABLED === "true";
