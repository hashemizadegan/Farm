"use client";
import { StatusPill } from "@metafarm/ui";
import type { RealtimeStatus as Status } from "@/lib/realtime";
import { useI18n } from "@/i18n/provider";

/** How fresh the page is: live updates, or polling while the channel connects, reconnects or is unavailable. */
export function RealtimeStatus({ status }: { status: Status }) {
  const t = useI18n().m.realtime;
  if (status === "off") return null; // realtime not configured: the page simply polls, as before
  const tone = status === "live" ? "ok" : status === "unavailable" ? "neutral" : "pending";
  return (
    <p role="status" aria-live="polite" className="realtime-status">
      <StatusPill tone={tone}>{t[status]}</StatusPill>
    </p>
  );
}

/** Polling interval while realtime is not live (the existing rate) and the slower safety net while it is. */
export const pollWhile = (status: Status, normalMs: number) => (status === "live" ? Math.max(normalMs, 60_000) : normalMs);
