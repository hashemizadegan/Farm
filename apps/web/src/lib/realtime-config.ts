/**
 * Realtime configuration shared by the page code and middleware.ts (Edge): no React, no session. The URL was checked
 * at build time by next.config.ts (packages/config webRealtimeCapability).
 */

/** The channel URL when the build enabled realtime (next.config.ts checked it); otherwise undefined (polling only). */
export function realtimeUrl(env: { state?: string; url?: string } = { state: process.env.NEXT_PUBLIC_REALTIME_STATE, url: process.env.NEXT_PUBLIC_REALTIME_URL }): string | undefined {
  return env.state === "enabled" && env.url ? env.url : undefined;
}

/** The CSP connect-src entry for the channel: its exact origin, only for a valid ws(s) URL; never a wildcard. */
export function realtimeConnectSource(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if ((u.protocol !== "wss:" && u.protocol !== "ws:") || u.hostname.includes("*")) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
