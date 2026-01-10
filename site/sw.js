// Simple service worker for PnL Traden
// - Cache app shell for offline use
// - Network-first for /data/pnl.json (so you see latest), with cache fallback

const CACHE = "pnl-traden-v1.0.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./data/pnl.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k))));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Network-first for the data file
  if (url.pathname.endsWith("/data/pnl.json")) {
    event.respondWith((async () => {
      try {
        const res = await fetch(event.request, { cache: "no-store" });
        const cache = await caches.open(CACHE);
        cache.put(event.request, res.clone());
        return res;
      } catch {
        const cached = await caches.match(event.request);
        return cached || new Response(JSON.stringify({ rows: [], generated_at: null }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    })());
    return;
  }

  // Cache-first for app shell
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const res = await fetch(event.request);
    const cache = await caches.open(CACHE);
    cache.put(event.request, res.clone());
    return res;
  })());
});
