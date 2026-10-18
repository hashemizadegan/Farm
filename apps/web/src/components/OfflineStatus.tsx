"use client";
import { useCallback, useEffect } from "react";
import { Button, useAnnounce } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { discard, flush, useOnline, useOutbox } from "@/lib/outbox";
import { useTenant } from "@/lib/tenant";

/** Tells pages that queued records reached the server, so lists refresh. */
export const SYNCED_EVENT = "metafarm:synced";

/**
 * Offline state and the phone's queue of unsent records: shown only when offline or when
 * something is waiting. Sends the queue when the connection returns, on start, and every 30 s.
 */
export function OfflineStatus() {
  const { m, fmt } = useI18n();
  const t = m.offline;
  const announce = useAnnounce();
  const { me } = useTenant();
  const userId = me?.userId;
  const online = useOnline();
  const entries = useOutbox(userId);
  const pending = entries.filter((e) => e.status === "pending").length;
  const failed = entries.filter((e) => e.status === "failed");

  const send = useCallback(async () => {
    if (!userId || !navigator.onLine) return;
    const sent = await flush(userId);
    if (sent > 0) {
      announce(t.sent(sent));
      window.dispatchEvent(new Event(SYNCED_EVENT));
    }
  }, [userId, announce, t]);

  useEffect(() => {
    if (online && pending > 0) void send();
  }, [online, pending, send]);
  useEffect(() => {
    if (!online || pending === 0) return;
    const id = setInterval(() => void send(), 30_000);
    return () => clearInterval(id);
  }, [online, pending, send]);

  if (online && entries.length === 0) return null;
  return (
    <section className="offline-status" data-offline={!online || undefined} aria-label={t.region}>
      {!online && <p className="offline-status__line">{t.offline}</p>}
      {pending > 0 && (
        <p className="offline-status__line">
          {t.waitingCount(pending)}{" "}
          {online && (
            <Button onClick={() => void send()}>
              {t.sendNow}
            </Button>
          )}
        </p>
      )}
      {failed.length > 0 && (
        <details className="offline-status__failed" open>
          <summary>{t.failedCount(failed.length)}</summary>
          <ul>
            {failed.map((e) => (
              <li key={e.id}>
                <strong>{t.kinds[e.kind]}:</strong> {e.label} <span className="mf-hint">({fmt.dateTime(e.createdAt)})</span>
                {e.error && <span className="mf-error"> {e.error}</span>}{" "}
                <Button variant="danger" onClick={() => discard(e.id)}>
                  {t.discard}
                  <span className="mf-visually-hidden"> {e.label}</span>
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
