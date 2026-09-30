#!/usr/bin/env node
/**
 * company-pages.mjs — one small file per company, written at deploy.
 *
 * WHY A FILE PER COMPANY
 * ----------------------
 * The Worker writes each company page's HTML before JavaScript runs (src/seo.js),
 * so a crawler, a link preview and a reader on a failed script load all get the
 * company, not "Vision needs JavaScript". It needs the company's numbers to do
 * that — and screen.json is 2 MB. Parsing it inside a request is ~10-20 ms of
 * CPU on a plan that allows ten, so the page would fail exactly when it is cold.
 *
 * So the split happens here, once per deploy: public/c/<KEY>.json is ~2 KB, the
 * Worker reads one, and Vision's company view reads the same one for the fields
 * screen-lite.json drops (the since-last-build deltas, margins). Nothing is
 * recomputed — every value is copied from the feed that published it.
 *
 * Also written:
 *   public/c/_site.json        a few site-level facts the route pages quote
 *   public/vision-sitemap.xml  vision's home and one URL per company
 *
 * All of it is generated. None of it is committed (.gitignore): a committed
 * copy is a second, older answer sitting beside the feed it was cut from.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

const read = (f) => { try { return JSON.parse(readFileSync(`public/${f}`, "utf8")); } catch { return null; } };
export const keyOf = (sym) => String(sym).toUpperCase().replace(/[^A-Z0-9-]/g, "_");

const full = read("screen.json"), lite = read("screen-lite.json");
const src = (full && full.rows && full.rows.length ? full : lite);
if (!src || !Array.isArray(src.rows) || !src.rows.length) {
  console.log("company-pages: no screen feed — nothing written, route pages fall back to their generic copy");
  process.exit(0);
}
const insti = read("institutional.json") || {};
const vsig = read("vision_signals.json") || {};
const baro = read("barometer.json") || {};
const pulse = read("pulse.json") || {};

const KEEP = ["sym", "name", "sector", "ind", "mcap_cr", "price", "r1d", "r1w", "r1m", "r3m", "r6m", "r1y",
  "high52", "low52", "from_high", "sma20", "sma50", "sma200", "rsi", "atr_pct", "turnover_cr", "vol_spike", "brk52w",
  "above_mas", "fy", "fy_count", "roce", "roce_med", "roce_trend", "roe", "de", "icover", "rev_cagr", "ebitda_cagr",
  "eps_cagr", "rev_yoy", "ebitda_yoy", "eps_yoy", "pat_yoy", "ebit_margin", "net_margin", "margin_delta", "em_label",
  "cfo_pat", "fcf_pat", "pe", "pb", "pe_pctile", "piotroski", "q", "g", "v", "tech", "comp", "risk", "delta",
  "rank_move", "shares_changed", "next_earnings", "last_date", "is_new"];

const breadth = (lite && lite.breadth) || (full && full.breadth) || {};
const ctxBase = {
  median_1m: breadth.median_1m ?? null,
  compared_with: (src.changes || {}).compared_with || null,
  threshold_pp: insti.threshold_pp ?? null,
  universe: src.rows.length,
  built_at: src.built_at || src.generated_at || null,
};

const openSig = {};
for (const h of vsig.history || []) {
  const st = (h.grade || {}).status || "open";
  if (st === "open" && !openSig[h.sym]) {
    openSig[h.sym] = { name: h.engine === "bottom" ? "Bottom reversal" : "4H breakout", fired_at: h.fired_at,
      entry: h.entry, sl: h.sl, t1: h.t1, t2: h.t2, t3: h.t3, status: (h.grade || {}).targets_hit ? `T${h.grade.targets_hit} reached` : "open" };
  }
}

rmSync("public/c", { recursive: true, force: true });
mkdirSync("public/c", { recursive: true });
const seen = new Map();
let n = 0;
for (const row of src.rows) {
  if (!row || !row.sym) continue;
  const k = keyOf(row.sym);
  if (seen.has(k)) throw new Error(`company-pages: ${row.sym} and ${seen.get(k)} share the file key ${k}`);
  seen.set(k, row.sym);
  const r = {};
  for (const f of KEEP) if (row[f] !== undefined && row[f] !== null) r[f] = row[f];
  const x = (insti.rows || {})[row.sym] || null;
  writeFileSync(`public/c/${k}.json`, JSON.stringify({ r, x, vsig: openSig[row.sym] || null, ctx: ctxBase }));
  n++;
}

/* ACROSS THE SCREEN — the "unusual today" counts Vision's home prints. Each is
   a threshold on a published field, stated beside the count on the page. */
const liquid = src.rows.filter((r) => r && r.sym && (r.turnover_cr || 0) >= 5);
const pick = (xs) => xs.map((r) => ({ sym: r.sym, name: r.name }));
const dc = (r) => (r.delta && Number.isFinite(r.delta.comp) ? r.delta.comp : null);
const today0 = Date.parse(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10));
const within = (d, n) => { const t = Date.parse(String(d || "").slice(0, 10)); return Number.isFinite(t) && t >= today0 && t - today0 <= n * 86400000; };
const moved = liquid.filter((r) => dc(r) != null);
const changed = {
  compared_with: (src.changes || {}).compared_with || null, min_turnover_cr: 5,
  up: moved.slice().sort((a, b) => dc(b) - dc(a)).filter((r) => dc(r) >= 5).slice(0, 8).map((r) => ({ sym: r.sym, name: r.name, d: dc(r) })),
  down: moved.slice().sort((a, b) => dc(a) - dc(b)).filter((r) => dc(r) <= -5).slice(0, 8).map((r) => ({ sym: r.sym, name: r.name, d: dc(r) })),
  vol: pick(liquid.filter((r) => (r.vol_spike || 0) >= 3).sort((a, b) => b.vol_spike - a.vol_spike).slice(0, 12)),
  vol_n: liquid.filter((r) => (r.vol_spike || 0) >= 3).length,
  hi52_n: liquid.filter((r) => r.brk52w).length, hi52: pick(liquid.filter((r) => r.brk52w).slice(0, 12)),
  results_n: src.rows.filter((r) => within(r.next_earnings, 7)).length,
  results: src.rows.filter((r) => within(r.next_earnings, 7)).sort((a, b) => String(a.next_earnings).localeCompare(String(b.next_earnings))).slice(0, 12).map((r) => ({ sym: r.sym, name: r.name, on: String(r.next_earnings).slice(0, 10) })),
};

const byTurn = src.rows.filter((r) => r && r.sym && Number.isFinite(r.turnover_cr)).sort((a, b) => b.turnover_cr - a.turnover_cr);
const t = baro.today || {};
writeFileSync("public/c/_site.json", JSON.stringify({
  built_at: ctxBase.built_at, universe: ctxBase.universe, median_1m: ctxBase.median_1m,
  advancing: breadth.advancing ?? null, declining: breadth.declining ?? null, at_52w_high: breadth.at_52w_high ?? null,
  above200: breadth.above200 ?? null, barometer: t.score != null ? { score: t.score, band: (t.band && t.band.t) || t.band || null, date: baro.generated_at || null } : null,
  week: pulse.breadth ? { up: pulse.breadth.up, down: pulse.breadth.down, counted: pulse.breadth.counted, built_on: pulse.built_on } : null,
  changed,
  top: byTurn.slice(0, 60).map((r) => ({ sym: r.sym, name: r.name, sector: r.sector, price: r.price, r1d: r.r1d })),
  vsig: { generated_at: vsig.generated_at || null, today: (vsig.today || []).map((s) => ({ sym: s.sym, name: s.name, engine: s.engine, entry: s.entry, sl: s.sl, t1: s.t1, t2: s.t2, t3: s.t3, fired_at: s.fired_at })) },
}));

const day = String(ctxBase.built_at || new Date().toISOString()).slice(0, 10);
const urls = [`  <url><loc>https://vision.askakshay.com/</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`]
  .concat([...seen.keys()].map((k) => `  <url><loc>https://vision.askakshay.com/company/${k}</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`));
writeFileSync("public/vision-sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
/* SIGNAL'S SITEMAP, FROM THE ROUTE TABLE. It was hand-written on 08 Sep and
   had drifted: six live routes missing, every lastmod three weeks old. The
   routes are the META table the Worker already writes heads from; company
   pages are listed on Vision only, which is where a company is researched. */
try {
  const { SIGNAL_META } = await import(new URL("../src/route-meta.js", import.meta.url));
  const skip = new Set(["/404", "/buoy"]);
  const pri = { "/": "1.0", "/signals": "0.9", "/screen": "0.9", "/markets": "0.8", "/brief": "0.8", "/ideas": "0.8" };
  const su = Object.keys(SIGNAL_META).filter((k) => !skip.has(k)).map((k) =>
    `  <url><loc>https://signal.askakshay.com${k}</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq><priority>${pri[k] || "0.6"}</priority></url>`);
  writeFileSync("public/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generated by scripts/company-pages.mjs from src/route-meta.js at deploy. -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${su.join("\n")}\n</urlset>\n`);
  console.log(`company-pages: sitemap.xml (${su.length} Signal routes)`);
} catch (e) { console.log("company-pages: sitemap.xml left as it was —", e.message); }

console.log(`company-pages: ${n} companies, _site.json, vision-sitemap.xml (${urls.length} URLs)`);
