"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@metafarm/ui";
import { CreateWorkspace } from "./CreateWorkspace";
import { useTenant } from "@/lib/tenant";

/** Renders children only once a tenant is selected; otherwise explains what to do. */
export function RequireTenant({ children }: { children: (tenantId: string) => ReactNode }) {
  const { signedIn, tenantId, loading, error, me } = useTenant();
  if (!signedIn) {
    return (
      <Notice title="Sign in required.">
        <Link href="/sign-in">Sign in</Link> to see your farms.
      </Notice>
    );
  }
  if (loading) return <p role="status">Loading your workspace…</p>;
  if (error) return <Notice tone="error" title="Could not load your account.">{error.message}</Notice>;
  if (me && me.tenants.length === 0) return <CreateWorkspace />;
  if (!tenantId) return <p role="status">Loading your workspace…</p>;
  return <>{children(tenantId)}</>;
}
