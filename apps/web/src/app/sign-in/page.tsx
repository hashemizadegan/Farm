"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Notice, TextField } from "@metafarm/ui";
import { devSession } from "@/lib/auth";

/**
 * Development sign-in. Paste a token from `pnpm --filter @metafarm/api dev-token`.
 * TODO(provider-config): replace with a redirect to your OIDC provider.
 */
export default function SignInPage() {
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
        This screen exists only for local development. Production deployments use your OpenID Connect provider.
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
