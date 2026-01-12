// sw.js — PnL Traden
// Auto-update + clean old caches.
// IMPORTANT: never cache /data/pnl.json (always fetch latest).

const CACHE_VERSION = "v1_4_2";
const STATIC_CACHE = `pnl-static-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.startsWith("pnl-static-") && k !== STATIC_CACHE) ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Always fetch latest data (no cache)
  if (url.pathname.endsWith("/data/pnl.json")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // Cache-first for app shell
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;

    try {
      const fresh = await fetch(event.request);
      if (event.request.method === "GET" && url.origin === location.origin) {
        cache.put(event.request, fresh.clone());
      }
      return fresh;
    } catch (e) {
      if (event.request.mode === "navigate") {
        const index = await cache.match("./index.html");
        if (index) return index;
      }
      throw e;
    }
  })());
});
