"use client";
import { useEffect, useState } from "react";
import { Button, Notice } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { WalletLinkError, discoverWallets, linkWallet, type StandardWallet } from "@/lib/player-wallets";
import { shortAddress } from "@/lib/rwa";

/**
 * J8: the signed-in user's Solana player wallets, on the account page. Linking asks the user's own
 * wallet to sign a one-time message (no transaction, nothing authorised). A player wallet belongs to
 * the user's player identity; it is never an investor (RWA) wallet, and linking does not create one.
 */
export function PlayerWallets() {
  const t = useI18n().m.playerWallets;
  const linked = useQuery("player-wallets", () => unwrap(api.GET("/v1/me/player-wallets")));
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => discoverWallets(window, setWallets), []);

  async function link(w: StandardWallet) {
    setBusy(w.name);
    setError(null);
    setDone(null);
    try {
      const address = await linkWallet(w, {
        challenge: async (address) => unwrap(api.POST("/v1/me/player-wallets/challenge", { body: { address } })),
        link: async (address, signature) => void (await unwrap(api.POST("/v1/me/player-wallets", { body: { address, signature } }))),
      });
      setDone(t.linked(shortAddress(address) ?? address));
      linked.reload();
    } catch (e) {
      setError(e instanceof WalletLinkError ? t.errors[e.code] : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function unlink(address: string) {
    setBusy(address);
    setError(null);
    setDone(null);
    try {
      await unwrap(api.DELETE("/v1/me/player-wallets/{address}", { params: { path: { address } } }));
      linked.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="player-wallets-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="player-wallets-heading">{t.heading}</h2>
      <p className="mf-muted">{t.intro}</p>
      <Notice tone="info">{t.notInvestor}</Notice>
      {linked.error && <Notice tone="error">{linked.error.message}</Notice>}
      {linked.data && linked.data.items.length === 0 && <p>{t.none}</p>}
      {linked.data && linked.data.items.length > 0 && (
        <ul>
          {linked.data.items.map((w) => (
            <li key={w.address}>
              <code title={w.address}>{shortAddress(w.address)}</code>{" "}
              <Button variant="danger" busy={busy === w.address} onClick={() => unlink(w.address)} aria-label={t.unlinkLabel(w.address)}>
                {t.unlink}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h3>{t.linkHeading}</h3>
      <p className="mf-muted">{t.howItWorks}</p>
      {wallets.length === 0 ? (
        <p>{t.noWallet}</p>
      ) : (
        <ul>
          {wallets.map((w) => (
            <li key={w.name}>
              <Button variant="primary" busy={busy === w.name} disabled={busy !== null} onClick={() => link(w)}>
                {t.linkWith(w.name)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {done && <p role="status">{done}</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
