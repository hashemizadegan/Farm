/** Liveness for the platform health check; the only path the preview access gate lets through without credentials. */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
