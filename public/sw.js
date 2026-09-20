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
// Bumped with the typeface change. The fetch handler is network-first, so a
// stale version never pinned anyone to old code — but the OFFLINE shell was
// precaching seven faces the site stopped using and none of the one it now
// loads, so an offline visit fell back to system fonts.
//
// v3: THAT FIX WAS HALF OF ONE. It replaced the seven dead faces with the one
// variable face and stopped there, and the site loads THREE on every route.
// Measured across /, /brief, /screen, /radar, /signals and /methodology:
// Jakarta plus both JetBrains Mono weights, downloaded on all six. Every
// price, every ticker, every eyebrow and every table figure on this site is
// set in --mono, so the shell this was precaching rendered offline with the
// prose right and every NUMBER in a system monospace.
//
// Newsreader is deliberately NOT here. It is 23 KB for --b-serif, which one
// route uses; precaching it would spend the offline budget on the headings of
// a page a reader is unlikely to be looking at when the network drops.
const CACHE = "signal-shell-v3";
const SHELL = [
  "/", "/index.html", "/signal.css", "/signal.js", "/icon.svg",
  // One variable face, weights 200-800, replacing the five static Manrope and
  // Newsreader files the redesign retired.
  "/fonts/PlusJakarta-var-latin.woff2",
  // The numbers. Both weights: 400 is the table figure, 500 the eyebrow.
  "/fonts/JetBrainsMono-400-latin.woff2",
  "/fonts/JetBrainsMono-500-latin.woff2",
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
