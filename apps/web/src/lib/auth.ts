"use client";

/**
 * Browser-side authentication integration point.
 *
 * The API accepts OIDC bearer tokens. This placeholder keeps the token in
 * sessionStorage (cleared when the tab closes) and exposes a tiny interface
 * so a real OIDC client can replace it without touching pages.
 *
 * TODO(provider-config): replace `devSession` with your OIDC provider's
 * browser SDK or a server-side session (e.g. Authorization Code + PKCE).
 * Prefer httpOnly cookies on a backend-for-frontend if your provider
 * supports it; tokens in web storage are readable by any script on the page,
 * which is why the CSP in middleware.ts is strict.
 */
export interface Session {
  getToken(): string | undefined;
  signIn(token: string): void;
  signOut(): void;
  subscribe(cb: () => void): () => void;
}

const KEY = "metafarm.devToken";
const listeners = new Set<() => void>();

export const devSession: Session = {
  getToken() {
    if (typeof window === "undefined") return undefined;
    try {
      return window.sessionStorage.getItem(KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  signIn(token) {
    try {
      window.sessionStorage.setItem(KEY, token.trim());
    } catch {
      /* storage blocked */
    }
    listeners.forEach((l) => l());
  },
  signOut() {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  },
  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
