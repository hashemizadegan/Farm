"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Notice, TextField } from "@metafarm/ui";
import { devSession, getUserManager, oidcConfigured } from "@/lib/auth";
import { rememberReturnTo, takeReturnTo } from "@/lib/return-to";

export default function SignInPage() {
  // ?next=/path brings the user back to where they were (e.g. an invitation).
  useEffect(() => rememberReturnTo(new URLSearchParams(window.location.search).get("next")), []);
  return (
    <div className="signin">
      <p className="signin__brand">Metafarm</p>
      {oidcConfigured ? <OidcSignIn /> : <DevSignIn />}
    </div>
  );
}

function OidcSignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    setBusy(true);
    try {
      await getUserManager().signinRedirect();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <h1>Sign in</h1>
      <p>Plan farm projects on a map, record what you observe in the field, and explore each plan in 3D.</p>
      <p className="mf-hint">You will continue to the sign-in page and come back here afterwards.</p>
      {error && (
        <Notice tone="error" title="Could not start sign-in.">
          {error}
        </Notice>
      )}
      <Button variant="primary" onClick={start} busy={busy}>
        Continue to sign in
      </Button>
    </>
  );
}

/** Development sign-in: paste a token from `pnpm --filter @metafarm/api dev-token`. */
function DevSignIn() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.split(".").length !== 3) {
      setError("That does not look like a token. Paste the full value printed by the dev-token command.");
      return;
    }
    devSession.signIn(token);
    router.push(takeReturnTo());
  };

  return (
    <>
      <h1>Sign in</h1>
      <Notice tone="warning" title="Development sign-in.">
        This screen appears only when no OpenID Connect provider is configured. Deployed environments require one.
      </Notice>
      <form onSubmit={submit} noValidate>
        <TextField
          label="Development token"
          hint="Run: pnpm --filter @metafarm/api dev-token"
          name="token"
          autoComplete="off"
          value={token}
          error={error}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <Button type="submit" variant="primary">
          Sign in
        </Button>
      </form>
    </>
  );
}
