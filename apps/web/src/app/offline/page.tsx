"use client";
import Link from "next/link";
import { PageHeader } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";

/** Shown by the service worker for pages not yet opened on this device while there is no connection. */
export default function OfflinePage() {
  const { m } = useI18n();
  const t = m.offline;
  return (
    <>
      <PageHeader title={t.pageTitle} description={t.pageBody} />
      <nav aria-label={t.pageLinks}>
        <h2>{t.pageLinks}</h2>
        <ul>
          <li>
            <Link href="/tasks">{m.shell.nav.myTasks}</Link>
          </li>
          <li>
            <Link href="/">{m.shell.nav.overview}</Link>
          </li>
        </ul>
      </nav>
    </>
  );
}
