"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Notice } from "@metafarm/ui";
import { api } from "@/lib/api";
import { getUserManager, oidcConfigured } from "@/lib/auth";
import { takeReturnTo } from "@/lib/return-to";

/** Completes the OIDC Authorization Code + PKCE redirect. */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const ran = useRef(false);

  useEffect(() => {
    // React strict mode runs effects twice in development; the code can only be exchanged once.
    if (ran.current) return;
    ran.current = true;
    if (!oidcConfigured) {
      router.replace("/sign-in");
      return;
    }
    getUserManager()
      .signinRedirectCallback()
      .then(async (user) => {
        // Share the name and email from the sign-in provider with teammates. Best effort.
        const name = typeof user.profile.name === "string" ? user.profile.name : undefined;
        const email = typeof user.profile.email === "string" ? user.profile.email : undefined;
        if (name || email) {
          await api.PATCH("/v1/me/profile", { body: { ...(name ? { displayName: name } : {}), ...(email ? { email } : {}) } }).catch(() => undefined);
        }
        router.replace(takeReturnTo());
      })
      .catch((e: Error) => setError(e.message));
  }, [router]);

  return (
    <>
      <h1>Signing in</h1>
      {error ? (
        <Notice tone="error" title="Sign-in failed.">
          {error} <a href="/sign-in">Try again</a>
        </Notice>
      ) : (
        <p role="status">Completing sign-in…</p>
      )}
    </>
  );
}
