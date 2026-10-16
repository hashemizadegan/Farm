"use client";

/**
 * Browser-side authentication.
 *
 * Two implementations behind one `Session` interface:
 *  - OIDC (Authorization Code + PKCE via oidc-client-ts) when
 *    NEXT_PUBLIC_OIDC_AUTHORITY and NEXT_PUBLIC_OIDC_CLIENT_ID are set.
 *    Works with any standards-compliant provider (Auth0, Keycloak, Entra, …).
 *  - A development session (paste a token from `dev-token`) otherwise. The API
 *    refuses development tokens in staging/production, so this cannot be used
 *    to sign in to a deployed environment.
 *
 * Tokens are kept in sessionStorage (cleared when the tab closes). Any script on
 * the page can read web storage, which is why the CSP in middleware.ts is strict.
 */
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

export interface Session {
  readonly kind: "oidc" | "dev";
  getToken(): string | undefined;
  subscribe(cb: () => void): () => void;
  signOut(): Promise<void>;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

// ── Development session ────────────────────────────────────────────────────

const DEV_KEY = "metafarm.devToken";

export const devSession: Session & { signIn(token: string): void } = {
  kind: "dev",
  getToken() {
    if (typeof window === "undefined") return undefined;
    try {
      return window.sessionStorage.getItem(DEV_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  signIn(token) {
    try {
      window.sessionStorage.setItem(DEV_KEY, token.trim());
    } catch {
      /* storage blocked */
    }
    notify();
  },
  async signOut() {
    try {
      window.sessionStorage.removeItem(DEV_KEY);
    } catch {
      /* ignore */
    }
    notify();
  },
  subscribe,
};

// ── OIDC session ───────────────────────────────────────────────────────────

const AUTHORITY = process.env.NEXT_PUBLIC_OIDC_AUTHORITY;
const CLIENT_ID = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID;
// Some providers (e.g. Auth0) only issue a JWT access token for an API when an audience is requested.
const AUDIENCE = process.env.NEXT_PUBLIC_OIDC_AUDIENCE;

export const oidcConfigured = Boolean(AUTHORITY && CLIENT_ID);

let manager: UserManager | undefined;
let currentToken: string | undefined;

function setUser(user: User | null) {
  currentToken = user && !user.expired ? user.access_token : undefined;
  notify();
}

export function getUserManager(): UserManager {
  if (!oidcConfigured) throw new Error("OIDC is not configured");
  if (!manager) {
    const origin = window.location.origin;
    manager = new UserManager({
      authority: AUTHORITY!,
      client_id: CLIENT_ID!,
      redirect_uri: `${origin}/auth/callback`,
      post_logout_redirect_uri: `${origin}/sign-in`,
      response_type: "code",
      scope: "openid profile email",
      extraQueryParams: AUDIENCE ? { audience: AUDIENCE } : undefined,
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: false,
    });
    manager.events.addUserLoaded((u) => setUser(u));
    manager.events.addUserUnloaded(() => setUser(null));
    manager.events.addAccessTokenExpired(() => setUser(null));
    void manager.getUser().then(setUser);
  }
  return manager;
}

export const oidcSession: Session = {
  kind: "oidc",
  getToken() {
    if (typeof window === "undefined") return undefined;
    getUserManager();
    return currentToken;
  },
  subscribe,
  async signOut() {
    const m = getUserManager();
    await m.removeUser();
    setUser(null);
    try {
      await m.signoutRedirect();
    } catch {
      // Some providers do not advertise an end_session_endpoint; the local session is already cleared.
      window.location.assign("/sign-in");
    }
  },
};

export const session: Session = oidcConfigured ? oidcSession : devSession;
