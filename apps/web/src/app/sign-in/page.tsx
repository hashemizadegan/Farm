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
    <div className="landing">
      <section className="landing__plate" aria-labelledby="landing-headline">
        <p className="landing__brand">Metafarm</p>
        <SurveyDrawing />
        <div>
          <h1 id="landing-headline" className="landing__headline">
            Every farm starts with its boundary.
          </h1>
          <p className="landing__lede">
            Draw or import the field boundary, plan plantings inside it, record what you see on the ground, and keep a
            clear record of what has been checked and by whom.
          </p>
        </div>
      </section>
      <div className="landing__panel">{oidcConfigured ? <OidcSignIn /> : <DevSignIn />}</div>
    </div>
  );
}

// An illustrative field, not real data: its outer edge is drawn once, corner by corner, then the parcels settle in.
const FIELD: [number, number][] = [
  [42, 74],
  [208, 40],
  [350, 90],
  [366, 212],
  [236, 262],
  [68, 238],
];

function SurveyDrawing() {
  const d = `M${FIELD.map((p) => p.join(" ")).join(" L")} Z`;
  return (
    <svg className="landing__survey" viewBox="0 0 400 300" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="field-clip">
          <path d={d} />
        </clipPath>
      </defs>
      <path className="survey__fill" d={d} />
      <g className="survey__parcels" clipPath="url(#field-clip)">
        <path d="M222 20 L240 290" />
        <path d="M20 160 L380 148" />
        <path d="M120 20 L132 290" />
      </g>
      <path className="survey__edge" d={d} pathLength={1} />
      {FIELD.map(([x, y], i) => (
        // Each corner appears as the outline reaches it.
        <circle key={i} className="survey__vertex" cx={x} cy={y} r={5.5} style={{ animationDelay: `${0.3 + (i / FIELD.length) * 2.4}s` }} />
      ))}
      <text className="survey__label" x="200" y="290" textAnchor="middle">
        Illustrative boundary
      </text>
    </svg>
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
      <h2>Sign in</h2>
      <ul>
        <li>Boundaries are checked for valid shape and labelled with where they came from.</li>
        <li>A verifier can mark a boundary independently verified by attaching a survey or registry document.</li>
        <li>Plans, observations, photos and documents stay private to your workspace.</li>
      </ul>
      <p className="landing__foot">You will continue to a secure sign-in page and come back here afterwards. New here? You can create an account there.</p>
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
      <h2>Sign in</h2>
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
