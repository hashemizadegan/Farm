"use client";
import type { ReactNode } from "react";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useI18n } from "@/i18n/provider";

/** Public page frame: no sign-in, no app navigation. */
export function VerifyFrame({ children }: { children: ReactNode }) {
  const { m } = useI18n();
  return (
    <div className="verify">
      <header className="verify__top">
        <span className="verify__brand">{m.meta.title}</span>
        <LanguageSwitch />
      </header>
      {children}
      <footer className="verify__foot mf-hint">{m.verify.poweredBy}</footer>
    </div>
  );
}
