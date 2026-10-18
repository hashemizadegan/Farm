"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, EmptyState, PageHeader, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { useNotificationText } from "@/lib/notifications";
import { useTenant } from "@/lib/tenant";

export default function NotificationsPage() {
  const t = useI18n().m.notifications;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <RequireTenant>{(tenantId) => <Inbox tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Inbox({ tenantId }: { tenantId: string }) {
  const { m, fmt } = useI18n();
  const t = m.notifications;
  const announce = useAnnounce();
  const textOf = useNotificationText();
  const { bumpNotifications } = useTenant();
  const [version, setVersion] = useState(0);
  const q = useQuery(`notifications:${tenantId}:${version}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/notifications", { params: { path: { tenantId }, query: { limit: 100 } } })));

  async function markAll() {
    await unwrap(api.POST("/v1/tenants/{tenantId}/notifications/read", { params: { path: { tenantId } }, body: { all: true } }));
    announce(t.markedAll);
    bumpNotifications();
    setVersion((v) => v + 1);
  }

  async function open(id: string) {
    await api.POST("/v1/tenants/{tenantId}/notifications/read", { params: { path: { tenantId } }, body: { ids: [id] } }).catch(() => undefined);
    bumpNotifications();
  }

  if (q.loading && !q.data) return <p role="status">{t.loading}</p>;
  const items = q.data?.items ?? [];
  if (items.length === 0) return <EmptyState title={t.none} />;
  return (
    <>
      {q.data!.unread > 0 && (
        <p>
          <Button onClick={markAll}>{t.markAll}</Button>
        </p>
      )}
      <ul className="tasks">
        {items.map((n) => {
          const { text, href } = textOf(n);
          return (
            <li key={n.id} className="task notification" data-unread={!n.read || undefined}>
              <p className="notification__text">{text}</p>
              <p className="task__meta">
                {fmt.dateTime(n.createdAt)} ·{" "}
                <Link href={href} onClick={() => void open(n.id)}>
                  {t.open}
                </Link>
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
