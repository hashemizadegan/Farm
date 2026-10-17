"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Notice, TextField } from "@metafarm/ui";
import { devSession, getUserManager, oidcConfigured } from "@/lib/auth";
import { rememberReturnTo, takeReturnTo } from "@/lib/return-to";
import { useI18n } from "@/i18n/provider";
import { LanguageSwitch } from "@/components/LanguageSwitch";

export default function SignInPage() {
  // ?next=/path brings the user back to where they were (e.g. an invitation).
  useEffect(() => rememberReturnTo(new URLSearchParams(window.location.search).get("next")), []);
  const t = useI18n().m.signIn;
  return (
    <div className="landing">
      <section className="landing__plate" aria-labelledby="landing-headline">
        <p className="landing__brand">{t.brand}</p>
        <SurveyDrawing label={t.illustrative} />
        <div>
          <h1 id="landing-headline" className="landing__headline">
            {t.headline}
          </h1>
          <p className="landing__lede">{t.lede}</p>
        </div>
      </section>
      <div className="landing__panel">
        <LanguageSwitch className="landing__lang" />
        {oidcConfigured ? <OidcSignIn /> : <DevSignIn />}
      </div>
    </div>
  );
}

// An illustrative field, not real data: its outer edge is drawn once, corner by corner, then the parcels settle in.
const FIELD: [number, number][] = [
  [38, 92],
  [176, 46],
  [262, 58],
  [270, 104],
  [352, 116],
  [368, 206],
  [292, 252],
  [150, 268],
  [62, 222],
];

function SurveyDrawing({ label }: { label: string }) {
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
        <path d="M196 20 L214 290" />
        <path d="M20 168 L380 150" />
        <path d="M110 20 L118 290" />
      </g>
      <path className="survey__edge" d={d} pathLength={1} />
      {FIELD.map(([x, y], i) => (
        // Each corner appears as the outline reaches it.
        <circle key={i} className="survey__vertex" cx={x} cy={y} r={5.5} style={{ animationDelay: `${0.3 + (i / FIELD.length) * 2.4}s` }} />
      ))}
      <text className="survey__label" x="200" y="290" textAnchor="middle">
        {label}
      </text>
    </svg>
  );
}

function OidcSignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = useI18n().m.signIn;
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
      <h2>{t.heading}</h2>
      <ul>
        {t.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="landing__foot">{t.foot}</p>
      {error && (
        <Notice tone="error" title={t.couldNotStart}>
          {error}
        </Notice>
      )}
      <Button variant="primary" onClick={start} busy={busy}>
        {t.continue}
      </Button>
    </>
  );
}

/** Development sign-in: paste a token from `pnpm --filter @metafarm/api dev-token`. */
function DevSignIn() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const t = useI18n().m.signIn;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.split(".").length !== 3) {
      setError(t.devInvalid);
      return;
    }
    devSession.signIn(token);
    router.push(takeReturnTo());
  };

  return (
    <>
      <h2>{t.heading}</h2>
      <Notice tone="warning" title={t.devTitle}>
        {t.devText}
      </Notice>
      <form onSubmit={submit} noValidate>
        <TextField
          label={t.devToken}
          hint={t.devHint}
          name="token"
          autoComplete="off"
          value={token}
          error={error}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <Button type="submit" variant="primary">
          {t.heading}
        </Button>
      </form>
    </>
  );
}
