"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Notice, PageHeader, StatusPill } from "@metafarm/ui";
import type { MarketCurrency } from "@metafarm/domain";
import { useI18n } from "@/i18n/provider";
import { useCan } from "@/lib/can";
import { formatMoney } from "@/lib/market";

/**
 * Marketplace frame: the title, the simulation notice (on every marketplace page, never dismissible) and the section
 * tabs (catalogue, sell, orders; each shown only to roles that can use it).
 */
export function MarketChrome({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const t = useI18n().m.market;
  const pathname = usePathname();
  const can = useCan();
  const tabs: { href: string; label: string; show: boolean; current: boolean }[] = [
    { href: "/market", label: t.sections.catalogue, show: true, current: pathname === "/market" || /^\/market\/(?!sell|orders)[^/]+$/.test(pathname) },
    { href: "/market/sell", label: t.sections.sell, show: can("market:sell"), current: pathname.startsWith("/market/sell") },
    { href: "/market/orders", label: t.sections.orders, show: can("market:buy") || can("market:sell"), current: pathname.startsWith("/market/orders") },
  ];
  return (
    <>
      <PageHeader title={title ?? t.title} actions={actions} />
      <SimulationNotice />
      <nav aria-label={t.title} className="farm-tabs market-tabs">
        <ul>
          {tabs
            .filter((x) => x.show)
            .map((x) => (
              <li key={x.href}>
                <Link href={x.href} aria-current={x.current ? "page" : undefined}>
                  {x.label}
                </Link>
              </li>
            ))}
        </ul>
      </nav>
      {children}
    </>
  );
}

export function SimulationNotice() {
  const t = useI18n().m.market;
  return (
    <div className="market-sim" data-simulation-notice role="note">
      <StatusPill tone="pending">{t.simulatedTag}</StatusPill> <span>{t.simulation}</span>
    </div>
  );
}

/** An amount in its currency, in the reader's locale; kept left-to-right for the digits' sake inside RTL text. */
export function Money({ minor, currency }: { minor: number; currency: MarketCurrency }) {
  const { fmt } = useI18n();
  return <bdi className="money">{formatMoney(fmt.tag, minor, currency)}</bdi>;
}

/** A quantity with its unit, translated where the unit is a known one. */
export function useQty() {
  const { m, fmt } = useI18n();
  return (q: number, unit: string) => `${fmt.number(q, { maximumFractionDigits: 3 })} ${m.market.units[unit] ?? unit}`;
}

/** The API's refusal in the reader's language when it is a known one; its own message otherwise. */
export function useMarketError() {
  const t = useI18n().m.market;
  return (err: unknown) => {
    const e = err as { body?: { error?: string; message?: string; details?: { reasons?: string[] } }; message?: string };
    const code = e.body?.error ?? "";
    const reasons = e.body?.details?.reasons?.map((r) => t.reasons[r] ?? r);
    const base = t.errors[code] ?? e.body?.message ?? e.message ?? String(err);
    return reasons?.length ? `${base} (${reasons.join("; ")})` : base;
  };
}

export function NotEnabled({ error }: { error: { body?: { error?: string }; message?: string } | undefined }) {
  const t = useI18n().m.market;
  if (!error) return null;
  if (error.body?.error === "marketplace_not_enabled") return <Notice tone="warning">{t.notEnabled}</Notice>;
  return (
    <Notice tone="error" title={t.couldNotLoad}>
      {error.message}
    </Notice>
  );
}
