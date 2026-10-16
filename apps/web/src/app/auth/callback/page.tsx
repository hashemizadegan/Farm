"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Notice } from "@metafarm/ui";
import { getUserManager, oidcConfigured } from "@/lib/auth";

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
      .then(() => router.replace("/farms"))
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
