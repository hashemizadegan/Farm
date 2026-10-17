"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { HARVEST_CODE } from "@metafarm/domain";
import { Button, TextField } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { VerifyFrame } from "./VerifyFrame";

export default function VerifyLookupPage() {
  const t = useI18n().m.verify;
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();

  function submit(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!HARVEST_CODE.test(c)) return setError(t.codeInvalid);
    router.push(`/verify/${c}`);
  }

  return (
    <VerifyFrame>
      <h1>{t.lookupHeading}</h1>
      <p>{t.lookupIntro}</p>
      <form onSubmit={submit} noValidate className="card">
        <TextField label={t.code} hint={t.codeHint} value={code} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={14} error={error} onChange={(e) => setCode(e.target.value)} />
        <Button type="submit" variant="primary">
          {t.check}
        </Button>
      </form>
    </VerifyFrame>
  );
}
