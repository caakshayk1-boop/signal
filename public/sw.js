/**
 * sw.js — an offline shell, and nothing more.
 *
 * WHAT IS CACHED: the app shell — index.html, the stylesheet, the renderer and
 * the fonts. These are versioned by CACHE and replaced wholesale on deploy.
 *
 * WHAT IS DELIBERATELY NOT CACHED: every price. /api/* and the JSON feeds go
 * to the network every time and are never served from a cache, because a
 * cached quote is a stale number wearing a live badge — the one failure this
 * whole site is built to avoid. Offline, the shell loads and the data areas
 * show their existing "did not load" states, which is the truth.
 */
const CACHE = "signal-shell-v1";
const SHELL = [
  "/", "/index.html", "/signal.css", "/signal.js", "/icon.svg",
  "/fonts/Manrope-400-latin.woff2", "/fonts/Manrope-500-latin.woff2",
  "/fonts/Manrope-600-latin.woff2", "/fonts/Manrope-700-latin.woff2",
  "/fonts/JetBrainsMono-400-latin.woff2", "/fonts/JetBrainsMono-500-latin.woff2",
  "/fonts/Newsreader-400-latin.woff2",
];

self.addEventListener("install", (e) => {
  // addAll rejects the whole install if ANY entry 404s, which would leave the
  // site with no service worker and no error anyone would see. Each file is
  // added on its own and a miss is skipped.
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Prices are never cached. Not on a hit, not on a miss, not while offline.
  if (url.pathname.startsWith("/api/") || url.pathname.endsWith(".json")) return;

  // Shell: network first so a deploy is picked up immediately, cache as the
  // offline fallback. The reverse order would serve yesterday's app all day.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res && res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch {
      const hit = await caches.match(e.request);
      return hit || caches.match("/index.html");
    }
  })());
});
