import { generateKeyPairSync, sign } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * J8 in a real browser, with a stand-in for a browser wallet: a Wallet Standard wallet injected into
 * the page whose key stays in the test process (it signs through an exposed function). It offers the
 * transaction features too, and the test checks that the page never calls them. This is not a real
 * wallet extension; trying one (Phantom, Solflare, Backpack) is still a manual check.
 */
test.describe("player wallets (J8)", () => {
  test.skip(process.env.NEXT_PUBLIC_PLAYER_WALLETS_ENABLED !== "true", "player wallets are off in this build");

  test("links a wallet by signing a message, shows it, and unlinks it", async ({ page }) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = base58(new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)));
    const calls: string[] = [];
    await page.exposeFunction("e2eWalletCall", (feature: string) => void calls.push(feature));
    await page.exposeFunction("e2eWalletSign", (bytes: number[]) => [...sign(null, Buffer.from(bytes), privateKey)]);
    await page.addInitScript((addr: string) => {
      const w = window as unknown as {
        e2eWalletCall: (f: string) => Promise<void>;
        e2eWalletSign: (b: number[]) => Promise<number[]>;
      };
      const account = { address: addr, publicKey: new Uint8Array(32), chains: ["solana:devnet"], features: ["solana:signMessage"] };
      const wallet = {
        version: "1.0.0",
        name: "E2E Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        chains: ["solana:devnet"],
        accounts: [] as unknown[],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => {
              await w.e2eWalletCall("standard:connect");
              return { accounts: [account] };
            },
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async ({ message }: { message: Uint8Array }) => {
              await w.e2eWalletCall("solana:signMessage");
              const signature = new Uint8Array(await w.e2eWalletSign([...message]));
              return [{ signedMessage: message, signature }];
            },
          },
          "solana:signTransaction": { version: "1.0.0", signTransaction: async () => w.e2eWalletCall("solana:signTransaction") },
          "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: async () => w.e2eWalletCall("solana:signAndSendTransaction") },
        },
      };
      const callback = (app: { register: (x: unknown) => void }) => app.register(wallet);
      // Register whether the page is already listening or announces itself later.
      window.addEventListener("wallet-standard:app-ready", (e) => callback((e as CustomEvent).detail));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
    }, address);

    await signIn(page);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Player wallets" })).toBeVisible();
    await expect(page.getByText(/not an investor wallet/)).toBeVisible();

    await page.getByRole("button", { name: "Link with E2E Wallet" }).click();
    const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
    await expect(page.getByText(`Wallet ${short} linked.`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Unlink wallet ${address}` })).toBeVisible();
    expect(calls).toEqual(["standard:connect", "solana:signMessage"]);

    const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(a11y.violations).toEqual([]);

    await page.getByRole("button", { name: `Unlink wallet ${address}` }).click();
    await expect(page.getByRole("button", { name: `Unlink wallet ${address}` })).toHaveCount(0);
    expect(calls.some((c) => c.includes("Transaction"))).toBe(false);
  });
});
