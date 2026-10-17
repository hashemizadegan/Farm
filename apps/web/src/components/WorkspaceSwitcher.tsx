"use client";
import Link from "next/link";
import { ROLE_LABELS } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";

/** Current workspace and role; a native select when the user belongs to several. */
export function WorkspaceSwitcher() {
  const { me, tenantId, setTenantId } = useTenant();
  if (!me) return <div className="ws ws--loading" aria-hidden="true" />;
  if (me.tenants.length === 0) return null;
  const current = me.tenants.find((t) => t.tenantId === tenantId) ?? me.tenants[0]!;

  return (
    <div className="ws">
      {me.tenants.length > 1 ? (
        <>
          <label htmlFor="workspace-select" className="ws__label">
            Workspace
          </label>
          <select id="workspace-select" className="ws__select" value={current.tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {me.tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="ws__name">{current.name}</p>
      )}
      <p className="ws__role">Your role: {ROLE_LABELS[current.role].label}</p>
      <Link href="/workspaces/new" className="ws__new">
        New workspace
      </Link>
    </div>
  );
}
