/**
 * /api/heat?part=N — live quotes for the whole screen, in shards.
 *
 * WHY SHARDS, AND WHY CACHED HERE
 * -------------------------------
 * The heatmap shows every name on the screen (~1,000). Asked for through
 * ?px= at 40 a call, that is 25 requests a minute per open tab, each one two
 * Yahoo spark calls — 50 upstream calls a minute PER VIEWER, which is how a
 * site gets rate-limited. And one Worker invocation on the free plan may make
 * at most 50 subrequests, so the whole universe cannot be fetched in one call.
 *
 * So the universe — screen-lite.json, ordered by turnover — is cut into
 * shards of 200 (10 spark calls each), and each shard's answer is kept in the
 * edge cache for 60 s. Every viewer in a minute shares one fetch per shard:
 * ~50 upstream calls a minute in total, whatever the audience.
 *
 * Shard 0 is the 200 most-traded names, which is all the overview strip needs.
 * A shard that came back empty is not cached, so a Yahoo blip is retried by
 * the next viewer rather than served to everyone for a minute.
 */
import { quoteSpark } from "./ticker.js";

export const HEAT_PART = 200;
const TTL = 60;

let UNI = null; // { t, syms } — per isolate; the screen is rebuilt at most daily
async function universe(env, origin) {
  if (UNI && Date.now() - UNI.t < 10 * 60e3) return UNI.syms;
  const r = await env.ASSETS.fetch(new Request(`${origin}/screen-lite.json`));
  if (!r.ok) throw new Error(`screen-lite.json HTTP ${r.status}`);
  const j = await r.json();
  const syms = (j.rows || []).filter((x) => x && x.sym)
    .sort((a, b) => (b.turnover_cr || 0) - (a.turnover_cr || 0) || String(a.sym).localeCompare(String(b.sym)))
    .map((x) => String(x.sym));
  UNI = { t: Date.now(), syms };
  return syms;
}

export default async function heat(request, env, ctx) {
  const url = new URL(request.url);
  const part = Number(url.searchParams.get("part") ?? 0);
  if (!Number.isInteger(part) || part < 0 || part > 50) {
    return Response.json({ ok: false, error: "part must be a small whole number" }, { status: 400 });
  }
  const key = new Request(`${url.origin}/api/heat?part=${part}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }

  let syms;
  try { syms = await universe(env, url.origin); }
  catch (e) { return Response.json({ ok: false, error: `universe unavailable: ${e.message}` }, { status: 502 }); }
  const parts = Math.ceil(syms.length / HEAT_PART);
  const batch = syms.slice(part * HEAT_PART, (part + 1) * HEAT_PART);

  const quotes = {};
  if (batch.length) {
    const got = await quoteSpark(batch.map((s) => `${s}.NS`));
    for (const s of batch) {
      const h = got.get(`${s}.NS`);
      // Missing is missing, never zero — same rule as ?px=.
      if (h && Number.isFinite(h.price)) {
        const prev = Number.isFinite(h.prev) && h.prev !== 0 ? h.prev : null;
        quotes[s] = { price: h.price, change_pct: prev ? ((h.price - prev) / prev) * 100 : null };
      }
    }
  }
  const n = Object.keys(quotes).length;
  const res = Response.json(
    { ok: n > 0 || !batch.length, at: new Date().toISOString(), part, parts, asked: batch.length, got: n, quotes,
      ...(n || !batch.length ? {} : { error: "no quotes came back for this shard" }) },
    { status: n || !batch.length ? 200 : 502, headers: { "cache-control": `public, max-age=${TTL}` } },
  );
  if (cache && n) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
