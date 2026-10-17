"use client";
import Link from "next/link";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";

/** Current workspace and role; a native select when the user belongs to several. */
export function WorkspaceSwitcher() {
  const { me, tenantId, setTenantId } = useTenant();
  const { m } = useI18n();
  if (!me) return <div className="ws ws--loading" aria-hidden="true" />;
  if (me.tenants.length === 0) return null;
  const current = me.tenants.find((t) => t.tenantId === tenantId) ?? me.tenants[0]!;

  return (
    <div className="ws">
      {me.tenants.length > 1 ? (
        <>
          <label htmlFor="workspace-select" className="ws__label">
            {m.switcher.label}
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
      <p className="ws__role">{m.switcher.role(m.roles[current.role].label)}</p>
      <Link href="/workspaces/new" className="ws__new">
        {m.switcher.newWorkspace}
      </Link>
    </div>
  );
}
