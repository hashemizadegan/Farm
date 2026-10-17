"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@metafarm/ui";
import { CreateWorkspace } from "./CreateWorkspace";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";

/** Renders children only once a tenant is selected; otherwise explains what to do. */
export function RequireTenant({ children }: { children: (tenantId: string) => ReactNode }) {
  const { signedIn, tenantId, loading, error, me } = useTenant();
  const { m } = useI18n();
  if (!signedIn) {
    return (
      <Notice title={m.tenant.signInRequired}>{m.tenant.signInToSee((t) => <Link href="/sign-in">{t}</Link>)}</Notice>
    );
  }
  if (loading) return <p role="status">{m.tenant.loadingWorkspace}</p>;
  if (error) return <Notice tone="error" title={m.tenant.couldNotLoadAccount}>{error.message}</Notice>;
  if (me && me.tenants.length === 0) return <CreateWorkspace />;
  if (!tenantId) return <p role="status">{m.tenant.loadingWorkspace}</p>;
  return <>{children(tenantId)}</>;
}
