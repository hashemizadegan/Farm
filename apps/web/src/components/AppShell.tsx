"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { AnnouncerProvider, SkipLink } from "@metafarm/ui";
import { session } from "@/lib/auth";
import { TenantProvider, useTenant } from "@/lib/tenant";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AnnouncerProvider>
      <TenantProvider>
        <SkipLink />
        <Header />
        <RouteFocus>{children}</RouteFocus>
      </TenantProvider>
    </AnnouncerProvider>
  );
}

/** Moves focus to <main> on client-side navigation so keyboard and screen-reader users land on new content. */
function RouteFocus({ children }: { children: ReactNode }) {
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
    <main id="main" ref={ref} tabIndex={-1}>
      {children}
    </main>
  );
}

function Header() {
  const pathname = usePathname();
  const { me, tenantId, setTenantId, signedIn } = useTenant();
  const link = (href: string, label: string) => (
    <li>
      <Link href={href} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}>
        {label}
      </Link>
    </li>
  );
  return (
    <header className="app-header">
      <Link href="/farms" className="app-brand">
        Metafarm
      </Link>
      <nav aria-label="Main">
        <ul>
          {link("/farms", "Farms")}
          {link("/assets", "Asset catalogue")}
          {link("/about/disclosures", "Disclosures")}
        </ul>
      </nav>
      <div className="mf-toolbar" style={{ margin: 0 }}>
        {me && me.tenants.length > 1 && (
          <>
            <label htmlFor="tenant-select">Workspace</label>
            <select id="tenant-select" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {me.tenants.map((t) => (
                <option key={t.tenantId} value={t.tenantId}>
                  {t.name} ({t.role})
                </option>
              ))}
            </select>
          </>
        )}
        {signedIn ? (
          <button type="button" className="mf-button" onClick={() => void session.signOut()}>
            Sign out
          </button>
        ) : (
          <Link href="/sign-in">Sign in</Link>
        )}
      </div>
    </header>
  );
}
