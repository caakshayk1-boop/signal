/**
 * /api/snapshot — a dated, signed copy of a Vision company read.
 *
 *   GET /api/snapshot?sym=TCS   → { ok, token, url }   make one
 *   GET /api/snapshot?t=<token> → { ok, verified, snap } open one
 *
 * WHY THE WORKER MAKES IT, NOT THE BROWSER. A snapshot is a link someone
 * forwards, and it opens on vision.askakshay.com. If the browser built it,
 * anyone could put any figure in a URL and have this site display it under
 * its own name. So the browser sends only a symbol; the Worker computes every
 * figure from the same per-company file and the same insight.js the company
 * page uses, and signs the result. Opening a snapshot verifies the signature
 * first and shows nothing from a token that fails.
 *
 * NO STORAGE. The figures travel inside the token (deflated, base64url), so a
 * snapshot costs no database row — Turso is the one paid line here, and a
 * share link is not worth a write. The cost is a long URL (~2–3 KB).
 *
 * THE KEY. SNAPSHOT_KEY if set; otherwise one derived from EDIT_KEY with a
 * fixed label, so a snapshot signature can never stand in for a ledger
 * session or the reverse. Neither set: snapshots are refused, never unsigned.
 */
import "../../public/insight.js";              // attaches globalThis.VisionInsight

const VISION = "https://vision.askakshay.com";
const LABEL = "vision-snapshot/1";
const MAX_TOKEN = 12000;
const keyOf = (sym) => String(sym).toUpperCase().replace(/[^A-Z0-9-]/g, "_");
const enc = new TextEncoder();

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const b64u = (buf) => {
  let s = ""; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmacKey(env) {
  let material;
  if (env.SNAPSHOT_KEY) material = enc.encode(env.SNAPSHOT_KEY);
  else if (env.EDIT_KEY) {
    const base = await crypto.subtle.importKey("raw", enc.encode(env.EDIT_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    material = await crypto.subtle.sign("HMAC", base, enc.encode(LABEL));
  } else return null;
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
const sign = async (key, body) => hex(await crypto.subtle.sign("HMAC", key, enc.encode(LABEL + "." + body))).slice(0, 40);
const sameLen = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

async function deflate(str) {
  const s = new Blob([enc.encode(str)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Response(s).arrayBuffer();
}
async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(s).text();
}

/* What a snapshot holds: the company page's own reads, as computed now.
   Short keys because every byte is in the URL. */
function build(d, today) {
  const I = globalThis.VisionInsight;
  const r = d.r, x = d.x, ctx = Object.assign({ today }, d.ctx, { vsig: d.vsig });
  const om = I.oneMinute(r, x, ctx), mt = I.matters(r, x, ctx), qs = I.questions ? I.questions(r, x, ctx) : [];
  const n = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    v: 1, sym: r.sym, name: r.name || r.sym, sector: r.sector || null,
    taken: new Date().toISOString(),
    asof: { close: r.last_date || null, built: (d.ctx || {}).built_at || null, fy: r.fy || null,
            holding: x && x.quality === "complete" ? x.period : null },
    px: n(r.price), r1d: n(r.r1d), lo52: n(r.low52), hi52: n(r.high52),
    one: om.reads.map((o) => ({ k: o.k, w: o.word, f: o.fact, r: o.rule, t: o.tone || "" })),
    ev: om.event ? { t: om.event.t, s: om.event.s, src: om.event.src } : null,
    mt: mt.map((m) => ({ k: m.k, v: m.v, s: m.sub || "", t: m.tone || "", src: m.src || "" })),
    qs: qs.map((q) => ({ q: q.q, b: q.basis })),
  };
}

export default async function snapshot(request, env) {
  if (request.method !== "GET") return json({ ok: false, error: "GET only" }, 405);
  const url = new URL(request.url);
  const key = await hmacKey(env);
  if (!key) return json({ ok: false, error: "snapshots are not configured on this server" }, 503);

  const t = url.searchParams.get("t");
  if (t != null) {
    if (t.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+\.[0-9a-f]{40}$/.test(t)) return json({ ok: false, verified: false, error: "not a snapshot token" }, 400);
    const [body, sig] = t.split(".");
    if (!sameLen(sig, await sign(key, body))) return json({ ok: false, verified: false, error: "the signature does not match: this link was not made by Vision, or it was altered" }, 400);
    try {
      const snap = JSON.parse(await inflate(unb64u(body)));
      if (!snap || snap.v !== 1) throw new Error("unknown version");
      return json({ ok: true, verified: true, snap });
    } catch (e) {
      return json({ ok: false, verified: false, error: "the snapshot could not be read" }, 400);
    }
  }

  const sym = url.searchParams.get("sym");
  if (!sym || !/^[A-Za-z0-9&._-]{1,24}$/.test(sym)) return json({ ok: false, error: "sym is required" }, 400);
  let d = null;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(`/c/${keyOf(sym)}.json`, request.url), { method: "GET" }));
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) d = await r.json();
  } catch { d = null; }
  if (!d || !d.r) return json({ ok: false, error: `${keyOf(sym)} is not on the screen` }, 404);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const body = b64u(await deflate(JSON.stringify(build(d, today))));
  const token = `${body}.${await sign(key, body)}`;
  return json({ ok: true, token, url: `${VISION}/#/snap/${token}`, bytes: token.length });
}
