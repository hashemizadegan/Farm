/*
 * Metafarm service worker: keeps the app usable in the field without signal.
 *
 *  - Built assets (/_next/static, content-hashed) and icons: cache first.
 *  - Pages: network first; offline, the last copy of that page, else /offline.
 *  - API reads (GET /v1/... on the API origin): network first; offline, the last response.
 *    Cleared on sign-out (lib/auth.ts), since it holds the signed-in person's data.
 *  - Writes are never handled here: the app queues them itself (lib/outbox.ts).
 */
const VERSION = "v1";
const STATIC = `mf-static-${VERSION}`;
const PAGES = `mf-pages-${VERSION}`;
const API = "mf-api";
const KEEP = [STATIC, PAGES, API];
const LIMITS = { [STATIC]: 400, [PAGES]: 60, [API]: 300 };
const API_ORIGIN = new URL(self.location.href).searchParams.get("api") || "";
const PRECACHE = ["/offline", "/tasks"];
// Never kept offline: one-off downloads and files.
const API_SKIP = /\/(exports|uploads|media)\b/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { credentials: "same-origin" })).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mf-") && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const extra = keys.length - (LIMITS[name] || 200);
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function put(name, request, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  const cache = await caches.open(name);
  await cache.put(request, response);
  void trim(name);
}

async function cacheFirst(name, request) {
  const hit = await caches.match(request, { cacheName: name });
  if (hit) return hit;
  const res = await fetch(request);
  await put(name, request, res.clone());
  return res;
}

async function networkFirst(name, request, fallback) {
  try {
    const res = await fetch(request);
    await put(name, request, res.clone());
    return res;
  } catch (err) {
    const hit = (await caches.match(request, { cacheName: name })) || (fallback ? await fallback() : undefined);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === "/sw.js") return;
    if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
      event.respondWith(cacheFirst(STATIC, req));
      return;
    }
    if (req.mode === "navigate") {
      event.respondWith(networkFirst(PAGES, req, () => caches.match("/offline", { cacheName: PAGES })));
      return;
    }
    // In-app navigation data (RSC): when it fails, Next falls back to a full page load, handled above.
    return;
  }

  if (API_ORIGIN && url.origin === API_ORIGIN && url.pathname.startsWith("/v1/") && !API_SKIP.test(url.pathname)) {
    event.respondWith(networkFirst(API, req));
  }
});
