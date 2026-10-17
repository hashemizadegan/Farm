"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnnouncerProvider, SkipLink } from "@metafarm/ui";
import { session } from "@/lib/auth";
import { TenantProvider, useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";
import { LanguageSwitch } from "./LanguageSwitch";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/** Routes that render without the app chrome (sign-in and the OIDC callback). */
const BARE = ["/sign-in", "/auth/callback"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bare = BARE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const { m } = useI18n();
  return (
    <AnnouncerProvider>
      <TenantProvider>
        <SkipLink>{m.shell.skip}</SkipLink>
        {bare ? (
          <RouteFocus className="bare-main">{children}</RouteFocus>
        ) : (
          <Frame>
            <RouteFocus>{children}</RouteFocus>
          </Frame>
        )}
      </TenantProvider>
    </AnnouncerProvider>
  );
}

/** Moves focus to <main> on client-side navigation so keyboard and screen-reader users land on new content. */
function RouteFocus({ children, className }: { children: ReactNode; className?: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus();
  }, [pathname]);
  return (
    <main id="main" ref={ref} tabIndex={-1} className={className}>
      {children}
    </main>
  );
}

const NAV: { href: string; key: "overview" | "farms" | "assets" | "team" | "settings"; match?: (p: string) => boolean }[] = [
  { href: "/", key: "overview", match: (p) => p === "/" },
  { href: "/farms", key: "farms" },
  { href: "/assets", key: "assets" },
  { href: "/team", key: "team" },
  { href: "/settings", key: "settings" },
];

function Frame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { signedIn } = useTenant();
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the mobile drawer on navigation, and with Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const isCurrent = (item: (typeof NAV)[number]) =>
    item.match ? item.match(pathname) : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <div className="shell" data-nav-open={open || undefined}>
      <div className="topbar">
        <Link href="/" className="brand">
          <BrandMark />
          {m.meta.title}
        </Link>
        <button
          ref={toggleRef}
          type="button"
          className="topbar__menu"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? m.shell.closeMenu : m.shell.menu}
        </button>
      </div>

      <aside id="sidebar" className="sidebar" aria-label={m.shell.sidebar}>
        <Link href="/" className="brand brand--sidebar">
          <BrandMark />
          {m.meta.title}
        </Link>
        {signedIn && <WorkspaceSwitcher />}
        <nav aria-label={m.shell.mainNav}>
          <ul className="sidenav">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} aria-current={isCurrent(item) ? "page" : undefined}>
                  {m.shell.nav[item.key]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar__foot">
          <Link href="/about/disclosures" aria-current={pathname === "/about/disclosures" ? "page" : undefined}>
            {m.shell.disclosures}
          </Link>
          {signedIn && (
            <Link href="/account" aria-current={pathname === "/account" ? "page" : undefined}>
              {m.shell.account}
            </Link>
          )}
          {signedIn ? (
            <button type="button" className="sidebar__signout" onClick={() => void session.signOut()}>
              {m.shell.signOut}
            </button>
          ) : (
            <Link href="/sign-in">{m.common.signIn}</Link>
          )}
          <LanguageSwitch className="sidebar__lang" />
        </div>
      </aside>
      {open && <div className="scrim" aria-hidden="true" onClick={() => setOpen(false)} />}

      <div className="content">{children}</div>
    </div>
  );
}

/** A small plot outline: four field parcels inside a boundary. Decorative. */
function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M3 6.5 12 3l9 4.5-1.5 11L10 21l-7-4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 3.2 10.2 20.8M3.4 11.5l17-1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
