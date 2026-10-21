import { describe, expect, it } from "vitest";
import { CONNECT, SIGN_MESSAGE, USED_FEATURES, WalletLinkError, canLink, discoverWallets, linkWallet, type StandardWallet, type WalletAccount } from "./player-wallets";

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

/** A fake Wallet Standard wallet that records which features were called. */
function fakeWallet(opts: { tamper?: boolean; refuse?: boolean; chains?: readonly string[]; features?: readonly string[] } = {}) {
  const calls: string[] = [];
  const account: WalletAccount = { address: ADDRESS, publicKey: new Uint8Array(32), chains: ["solana:devnet"], features: [SIGN_MESSAGE] };
  const all: Record<string, unknown> = {
    [CONNECT]: {
      connect: async () => {
        calls.push(CONNECT);
        return { accounts: [account] };
      },
    },
    [SIGN_MESSAGE]: {
      signMessage: async ({ message }: { message: Uint8Array }) => {
        calls.push(SIGN_MESSAGE);
        if (opts.refuse) throw new Error("User rejected the request.");
        return [{ signedMessage: opts.tamper ? new Uint8Array([...message, 1]) : message, signature: new Uint8Array(64).fill(7) }];
      },
    },
    "solana:signTransaction": { signTransaction: async () => calls.push("solana:signTransaction") },
    "solana:signAndSendTransaction": { signAndSendTransaction: async () => calls.push("solana:signAndSendTransaction") },
  };
  const features = Object.fromEntries(Object.entries(all).filter(([k]) => !opts.features || opts.features.includes(k)));
  const wallet: StandardWallet = { name: "Fake", chains: opts.chains ?? ["solana:mainnet", "solana:devnet"], accounts: [], features };
  return { wallet, calls };
}

function fakeApi() {
  const sent: { address: string; signature: string }[] = [];
  return {
    sent,
    challenge: async (address: string) => ({ message: `app.example.com wants you to sign in with your Solana account:\n${address}` }),
    link: async (address: string, signature: string) => {
      sent.push({ address, signature });
    },
  };
}

describe("linkWallet", () => {
  it("connects, signs exactly the issued message, and sends the base64 signature", async () => {
    const { wallet, calls } = fakeWallet();
    const api = fakeApi();
    expect(await linkWallet(wallet, api)).toBe(ADDRESS);
    expect(api.sent).toEqual([{ address: ADDRESS, signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(7))) }]);
    expect(calls).toEqual([CONNECT, SIGN_MESSAGE]);
  });

  it("never calls a transaction feature, even when the wallet offers them", async () => {
    const { wallet, calls } = fakeWallet();
    await linkWallet(wallet, fakeApi());
    expect(calls.every((c) => (USED_FEATURES as readonly string[]).includes(c))).toBe(true);
    expect(calls.some((c) => c.includes("Transaction"))).toBe(false);
  });

  it("sends nothing when the wallet refuses, signs something else, or cannot sign messages", async () => {
    for (const [opts, code] of [
      [{ refuse: true }, "rejected"],
      [{ tamper: true }, "message_changed"],
      [{ features: [CONNECT] }, "not_supported"],
      [{ chains: ["ethereum:1"] }, "not_supported"],
    ] as const) {
      const api = fakeApi();
      const err = await linkWallet(fakeWallet(opts).wallet, api).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WalletLinkError);
      expect((err as WalletLinkError).code).toBe(code);
      expect(api.sent).toEqual([]);
    }
  });
});

describe("discoverWallets", () => {
  it("finds wallets that registered before and after the app, and only those that can link", () => {
    const target = new EventTarget() as unknown as Window;
    const early = fakeWallet().wallet;
    const late = fakeWallet().wallet;
    const evmOnly = fakeWallet({ chains: ["ethereum:1"] }).wallet;
    // A wallet that loaded first waits for app-ready, then registers.
    target.addEventListener("wallet-standard:app-ready", (e) => (e as CustomEvent).detail.register(early));
    const seen: StandardWallet[][] = [];
    const stop = discoverWallets(target, (w) => seen.push(w));
    target.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (app: { register: (...w: StandardWallet[]) => void }) => app.register(late, evmOnly) }));
    expect(seen.at(-1)).toEqual([early, late]);
    stop();
    expect(canLink(evmOnly)).toBe(false);
  });
});
