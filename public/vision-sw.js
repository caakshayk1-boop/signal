/**
 * vision-sw.js — Vision's offline shell, and nothing more.
 *
 * Its own file because Signal's sw.js precaches Signal's shell; a worker
 * shared by both products would hand a Vision reader Signal's index.html when
 * offline. Registered only on the vision host (see vision.js), so it can never
 * replace Signal's worker at the same scope on signal.askakshay.com/vision.
 *
 * WHAT IS CACHED: the shell — the home page, the stylesheet, the scripts, the
 * fonts, the icon. Network first, so a deploy is picked up on the next load.
 * WHAT IS NEVER CACHED: any price, any feed, any company file. /api/* and every
 * .json (including /c/<SYMBOL>.json) go to the network every time. Offline,
 * the shell opens and the panels say their data did not load — which is true.
 */
importScripts('/retirement.js');
const CACHE = "vision-shell-v2";
const SHELL = [
  "/", "/vision.css", "/vision.js", "/retirement.js", "/v2widgets.js", "/insight.js", "/vision-icon.svg",
  "/fonts/PlusJakarta-var-latin.woff2", "/fonts/JetBrainsMono-400-latin.woff2",
  "/fonts/JetBrainsMono-500-latin.woff2", "/fonts/Newsreader-400-latin.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k.startsWith('vision-shell-') && k !== CACHE);
    for (const k of old) await caches.delete(k);
    await self.clients.claim();
    if (old.length) for (const client of await self.clients.matchAll({ type: 'window' })) await client.navigate(client.url);
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (PublicRetirement.page(url.pathname) || PublicRetirement.asset(url.pathname)) {
    e.respondWith(Promise.resolve(new Response('This publication has been retired. Open / for company research.', { status: 410, headers: { 'cache-control': 'no-store' } })));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.endsWith(".json")) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res && res.ok && SHELL.includes(url.pathname)) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch {
      const hit = await caches.match(e.request);
      return hit || caches.match("/");
    }
  })());
});
