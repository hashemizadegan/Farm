"use client";
import { PageHeader } from "@metafarm/ui";
import { CreateWorkspace } from "@/components/CreateWorkspace";
import { useTenant } from "@/lib/tenant";
import Link from "next/link";
import { useI18n } from "@/i18n/provider";

export default function NewWorkspacePage() {
  const { signedIn } = useTenant();
  const t = useI18n().m.newWorkspace;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      {signedIn ? (
        <CreateWorkspace intro={false} redirectTo="/farms" />
      ) : (
        <p>{t.signInTo((x) => <Link href="/sign-in">{x}</Link>)}</p>
      )}
    </>
  );
}
