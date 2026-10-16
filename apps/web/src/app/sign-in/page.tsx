"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Notice, TextField } from "@metafarm/ui";
import { devSession, getUserManager, oidcConfigured } from "@/lib/auth";

export default function SignInPage() {
  return <>{oidcConfigured ? <OidcSignIn /> : <DevSignIn />}</>;
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
      <p>You will be sent to your organisation&apos;s sign-in page and returned here afterwards.</p>
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
    router.push("/farms");
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
