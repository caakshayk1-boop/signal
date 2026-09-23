#!/usr/bin/env node
/* ── LOCAL HARNESS FOR vision.askakshay.com — NEVER DEPLOYED ────────────────
 *
 * `wrangler dev` with no TURSO_URL proxies /api/* to production, which is the
 * right default and useless on a machine that cannot reach production. This
 * serves public/ as the Worker would for the vision host and answers /api/*
 * from what is already COMMITTED — the ledger snapshot, the pulse, the news
 * snapshot — so the page renders against real rows, not invented ones.
 *
 * Where no committed file can answer a route (FII/DII flows, most of the live
 * ticker), the fixture says so with ok:false. That is deliberate: it exercises
 * the page's "unavailable" states, which are the states nobody looks at until
 * production is down.
 *
 *   node scripts/vision-dev.mjs [port]            everything the snapshot has
 *   VDEV_FAIL=ticker,wire node scripts/vision-dev.mjs   force failures
 *   VDEV_SLOW=1500 node scripts/vision-dev.mjs    add latency to every /api
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.argv[2] || 8799);
const FAIL = new Set(String(process.env.VDEV_FAIL || "").split(",").filter(Boolean));
const SLOW = Number(process.env.VDEV_SLOW || 0);
/* VDEV_GRADE=1 grades the snapshot's closed rows the way the live API does —
   R = (exit - entry) / (entry - stop) — from the row's own committed fields,
   so the record page can be exercised locally. Off by default: the snapshot
   genuinely carries no R, and the page must be seen refusing that too. */
const GRADE = !!process.env.VDEV_GRADE;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

const j = (f) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));

/* The ledger: alerts.json is generate.py's snapshot of all_signals, in the
   /api/signals row shape. ?symbol= filters it the way the SQL LIKE does. */
function signals(q) {
  const rows = j("alerts.json").map((r) => {
    if (!GRADE) return r;
    const done = ["win", "loss", "expired"].includes(String(r.badge || "").toLowerCase());
    const risk = r.entry - r.sl;
    return { ...r, r_multiple: done && Number.isFinite(r.exit_price) && risk > 0
      ? Math.round((r.exit_price - r.entry) / risk * 1000) / 1000 : null };
  });
  if (q.get("px")) {
    const scr = new Map((j("screen-lite.json").rows || []).map((r) => [r.sym, r]));
    const out = {};
    for (const s of q.get("px").toUpperCase().split(",")) {
      const r = scr.get(s.replace(/\.NS$/, ""));
      // The screen's last close, as the nearest committed stand-in for a quote.
      if (r && Number.isFinite(r.price)) out[s] = { price: r.price, change_pct: r.r1d ?? null, basis: "screen close (dev)" };
    }
    return { ok: true, at: new Date().toISOString(), quotes: out };
  }
  const sym = (q.get("symbol") || "").toUpperCase();
  const pick = sym ? rows.filter((r) => String(r.symbol).toUpperCase().includes(sym)) : rows;
  return { ok: true, count: pick.length, offset: 0, limit: 400, version: "v2",
    generated_at: new Date().toISOString(), signals: pick };
}

/* The ticker: only rows a committed file can actually price. Nifty and India
   VIX from the barometer's last reading; everything else is absent, which is
   what the ticker itself does when Yahoo drops a symbol. */
function ticker() {
  const b = j("barometer.json").today || {};
  const scr = j("screen-lite.json").rows || [];
  const hist = (j("barometer.json").history || []).map((h) => h.nifty).filter(Number.isFinite);
  const row = (name, symbol, price, prev, trend) => ({
    name, symbol, price: price.toLocaleString("en-US", { maximumFractionDigits: 2 }), price_raw: price,
    change_pct: prev ? Math.round((price - prev) / prev * 10000) / 100 : 0, up: !prev || price >= prev,
    basis: "market", as_of: j("barometer.json").generated_at, session: "closed",
    trend: trend && trend.length >= 3 ? trend : null, w52_high: null, w52_low: null, range_pos: null,
  });
  const india = [];
  if (Number.isFinite(b.nifty)) india.push(row("Nifty 50", "^NSEI", b.nifty, hist[hist.length - 2], hist));
  if (Number.isFinite(b.vix)) india.push(row("India VIX", "^INDIAVIX", Math.round(b.vix * 100) / 100, null, null));
  const liquid = scr.filter((r) => Number.isFinite(r.r1d) && (r.turnover_cr ?? 0) > 200)
    .sort((a, b) => b.r1d - a.r1d);
  const mv = (r) => ({ name: r.sym, symbol: r.sym + ".NS", price: "₹" + r.price, price_raw: r.price,
    change_pct: r.r1d, up: r.r1d >= 0 });
  return { ok: true, fetched_at: new Date().toISOString(), live: india.length, total: india.length,
    advancing: india.filter((x) => x.up).length,
    segments: [
      { key: "india", label: "INDIA", icon: "", items: india },
      { key: "gainers", label: "NIFTY 50 GAINERS", icon: "", items: liquid.slice(0, 5).map(mv) },
      { key: "losers", label: "NIFTY 50 LOSERS", icon: "", items: liquid.slice(-5).reverse().map(mv) },
    ],
    constituents: [], ledger: {} };
}

/* The wire: news.json carries no timestamps, so neither does this. */
function wire() {
  const scope = { "Economic Times": "in", Livemint: "in", "Business Standard": "in", Moneycontrol: "in" };
  const stories = j("news.json").map((n) => ({ title: n.title, link: n.link, source: n.source,
    scope: scope[n.source] || "global", summary: n.summary || null, at: null }));
  return { ok: true, at: new Date().toISOString(), sources: 1, failed: [], stories };
}

const API = {
  "/api/signals": signals,
  "/api/ticker": ticker,
  "/api/wire": wire,
  "/api/flows": () => ({ ok: false, error: "dev harness: no committed flows fixture" }),
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p.startsWith("/api/")) {
    const key = p.replace(/\/+$/, "");
    if (SLOW) await new Promise((r) => setTimeout(r, SLOW));
    const name = key.slice(5);
    if (FAIL.has(name) || !API[key]) {
      res.writeHead(FAIL.has(name) ? 502 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: `dev: ${name} ${FAIL.has(name) ? "forced failure" : "no fixture"}` }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(API[key](u.searchParams)));
  }
  if (p === "/" || p === "/vision") p = "/vision.html";
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(f));
}).listen(PORT, () => console.log(`vision dev → http://127.0.0.1:${PORT}/  (fail: ${[...FAIL].join(",") || "none"})`));
