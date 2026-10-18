"use client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, unwrap, useQuery, type Schemas } from "./api";
import { session } from "./auth";

interface TenantState {
  me: Schemas["Me"] | undefined;
  tenantId: string | undefined;
  setTenantId: (id: string) => void;
  signedIn: boolean;
  loading: boolean;
  error: Error | undefined;
  /** Re-fetch /v1/me, e.g. after creating a workspace. */
  reloadMe: () => void;
  /** Unread notifications in the selected workspace (refreshed every minute). */
  unreadNotifications: number;
  /** Refresh the unread count now, e.g. after marking notifications read. */
  bumpNotifications: () => void;
}

const TenantContext = createContext<TenantState | null>(null);
const TENANT_KEY = "metafarm.tenantId";

export function TenantProvider({ children }: { children: ReactNode }) {
  const token = useSyncExternalStore(session.subscribe, session.getToken, () => undefined);
  const me = useQuery(token ? `me:${token.slice(-12)}` : null, () => unwrap(api.GET("/v1/me")));
  const [tenantId, setTenantIdState] = useState<string | undefined>();
  const [bump, setBump] = useState(0);
  const unread = useQuery(
    token && tenantId ? `unread:${tenantId}:${bump}` : null,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/notifications", { params: { path: { tenantId: tenantId! }, query: { unread: "true", limit: 1 } } })),
    { pollMs: 60_000 },
  );

  useEffect(() => {
    if (!me.data) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(TENANT_KEY);
    } catch {
      /* ignore */
    }
    const ids = me.data.tenants.map((t) => t.tenantId);
    setTenantIdState(stored && ids.includes(stored) ? stored : ids[0]);
  }, [me.data]);

  const setTenantId = (id: string) => {
    setTenantIdState(id);
    try {
      window.localStorage.setItem(TENANT_KEY, id);
    } catch {
      /* ignore */
    }
  };

  return (
    <TenantContext.Provider
      value={{
        me: me.data,
        tenantId,
        setTenantId,
        signedIn: !!token,
        loading: me.loading,
        error: me.error,
        reloadMe: me.reload,
        unreadNotifications: unread.data?.unread ?? 0,
        bumpNotifications: () => setBump((b) => b + 1),
      }}
    >
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenant must be used inside TenantProvider");
  return ctx;
}
