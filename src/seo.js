/**
 * seo.js — each route's own HTML, written at the edge before JavaScript runs.
 *
 * THE FAULT. Every page route on signal.askakshay.com was served the same
 * index.html: one <title>, one description, one canonical, one pre-render.
 * signal.js corrected the head after it ran, so a browser saw the right title,
 * but a crawler that does not run scripts, a link preview and a reader whose
 * bundle failed all saw the front page under every URL — /about, /markets and
 * /brief as one page. vision.askakshay.com was worse: its shell said only
 * "Vision needs JavaScript".
 *
 * THE FIX, WITHOUT A FRAMEWORK. HTMLRewriter streams the shell and rewrites
 * the head and the pre-render block per route. The browser app is unchanged:
 * it still replaces <main> on its first paint, so nothing here becomes a
 * second implementation of any page. What is written is short and true:
 *
 *   - titles and descriptions come from signal.js's own META table, extracted
 *     at build into route-meta.js (guard.mjs pins the copy);
 *   - company facts come from public/c/<KEY>.json, a ~2 KB slice of the screen
 *     written at deploy (scripts/company-pages.mjs) — parsing the 2 MB screen
 *     here would cost more CPU than the plan allows a request;
 *   - "what changed" is insight.js, the SAME file the browser runs.
 *
 * Every page body says it is a snapshot and when it was built.
 */
import { SIGNAL_META } from "./route-meta.js";
import "../public/insight.js";           // attaches globalThis.VisionInsight

const insight = globalThis.VisionInsight;

const SIGNAL = "https://signal.askakshay.com";
const VISION = "https://vision.askakshay.com";
export const keyOf = (sym) => String(sym).toUpperCase().replace(/[^A-Z0-9-]/g, "_");

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const inr = (v) => { const n = num(v); return n == null ? "—" : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: n >= 1000 ? 0 : 2 }); };
const pct = (v, dp = 1) => { const n = num(v); return n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(dp)}%`; };
const day = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t)
  ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : null; };
const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/* Small feeds, parsed once per isolate for five minutes. Only files of a few
   KB come through here — see the note at the top about the screen. */
const MEMO = new Map();
async function asset(env, request, path, ttl = 300_000) {
  const hit = MEMO.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  let v = null;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: "GET" }));
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) v = await r.json();
  } catch { v = null; }
  MEMO.set(path, { t: Date.now(), v });
  return v;
}

const htmlResponse = (res, status) => {
  const h = new Headers(res.headers);
  h.delete("etag"); h.delete("content-length");
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "public, max-age=0, must-revalidate");
  return new Response(res.body, { status: status || res.status, headers: h });
};

/* Head rewriting shared by both products. Tags missing from the shell are
   appended, so vision.html (which carries no Open Graph block) gets one. */
function headRewriter(m) {
  const seen = new Set();
  const set = (sel, attr, val, key) => [sel, { element(e) { seen.add(key); if (val == null) e.remove(); else e.setAttribute(attr, val); } }];
  const rw = new HTMLRewriter()
    .on("title", { element(e) { e.setInnerContent(m.title); } })
    .on(...set('meta[name="description"]', "content", m.desc, "d"))
    .on(...set('meta[name="robots"]', "content", m.robots, "r"))
    .on(...set('link[rel="canonical"]', "href", m.canonical, "c"))
    .on(...set('meta[property="og:title"]', "content", m.title, "ot"))
    .on(...set('meta[property="og:description"]', "content", m.desc, "od"))
    .on(...set('meta[property="og:url"]', "content", m.canonical, "ou"))
    .on(...set('meta[name="twitter:title"]', "content", m.title, "tt"))
    .on(...set('meta[name="twitter:description"]', "content", m.desc, "td"))
    .on("head", { element(e) {
      e.onEndTag((end) => {
        const add = [];
        if (!seen.has("c") && m.canonical) add.push(`<link rel="canonical" href="${esc(m.canonical)}">`);
        if (!seen.has("ot")) add.push(`<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(m.site)}">`
          + `<meta property="og:title" content="${esc(m.title)}"><meta property="og:description" content="${esc(m.desc)}">`
          + (m.canonical ? `<meta property="og:url" content="${esc(m.canonical)}">` : "")
          + `<meta property="og:image" content="${SIGNAL}/og.png"><meta name="twitter:card" content="summary_large_image">`
          + `<meta name="twitter:title" content="${esc(m.title)}"><meta name="twitter:description" content="${esc(m.desc)}">`);
        if (m.ld) add.push(`<script type="application/ld+json" id="ld-edge">${JSON.stringify(m.ld).replace(/</g, "\\u003c")}</script>`);
        if (add.length) end.before(add.join(""), { html: true });
      });
    } });
  return rw;
}

const crumbs = (items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([name, url], i) => ({ "@type": "ListItem", position: i + 1, name, item: url })) });

/* ─────────────────────────────── SIGNAL ─────────────────────────────── */

const SIGNAL_LINKS = [["/", "Today"], ["/opportunities", "Opportunities"], ["/watch", "Watchlist"],
  ["/performance", "Performance"], ["/markets", "Market"], ["/screen", "Screen"], ["/methodology", "Methodology"], ["/about", "About"]];

function signalFacts(route, site) {
  if (!site) return "";
  const built = day(site.built_at);
  const b = site.barometer, w = site.week;
  const line = (h) => `<p class="pre-m">${h}</p>`;
  switch (route) {
    case "/markets": case "/radar": case "/heat": case "/map":
      return (b ? line(`Market barometer <b>${esc(b.score)}/100</b> — ${esc(b.band || "")}${b.date ? `, as of ${esc(day(b.date))}` : ""}.`) : "")
        + (w ? line(`Over the past week <b>${esc(w.up)}</b> of <b>${esc(w.counted)}</b> screened names rose and <b>${esc(w.down)}</b> fell.`) : "")
        + (site.above200 != null ? line(`<b>${esc(site.above200)}%</b> of names trade above their 200-day average.`) : "");
    case "/screen": case "/discover":
      return line(`<b>${esc(site.universe)}</b> NSE names screened on price, trend, quality, value and institutional flow${built ? ` — build of ${esc(built)}` : ""}.`);
    case "/opportunities": case "/performance": case "/brief":
      return line("Signal: conditional next-session paper plans for NSE equities and a forward record of every one, from 1 October 2026. The live page loads them from the plan feed.");
    case "/watch":
      return line("Your watchlist is stored in this browser only. Star any name on the site to follow it here.");
    default: return "";
  }
}

export async function signalPage(request, env, path) {
  const shellReq = new Request(new URL("/", request.url), request);
  const shell = await env.ASSETS.fetch(shellReq);
  if (path === "/") return shell;                 // the deploy-time pre-render is already this route's
  const site = await asset(env, request, "/c/_site.json");

  if (path.startsWith("/stock/")) return signalStock(request, env, shell, decodeURIComponent(path.slice(7)), site);
  // A plan page is one row of the live feed; the generic plan head is
  // accurate for every id, and the app fills in the plan itself.
  const key = path.startsWith("/plan/") ? "/plan/:id" : path;

  const [title, desc] = SIGNAL_META[key] || SIGNAL_META["/404"];
  const h1 = title.split(" — ")[0];
  const canonical = SIGNAL + path;
  const body = `<p class="pre-k">Signal · ${esc(h1)}</p>
    <h1 class="pre-h">${esc(title)}</h1>
    <p class="pre-s">${esc(desc)}</p>${signalFacts(key, site)}
    <ul class="pre-l">${SIGNAL_LINKS.filter(([h]) => h !== path).map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join("")}<li><a href="${VISION}/">Vision — company research ↗</a></li></ul>
    <p class="pre-n">A summary written by the server${site && site.built_at ? ` from the build of ${esc(day(site.built_at))}` : ""}. The live page replaces it as soon as it loads.</p>`;
  const rw = headRewriter({ title, desc, canonical, site: "Signal", robots: "index,follow,max-image-preview:large",
    ld: { "@context": "https://schema.org", "@graph": [
      { "@type": "WebPage", "@id": canonical, url: canonical, name: title, description: desc, isPartOf: { "@id": `${SIGNAL}/#website` }, inLanguage: "en-IN" },
      crumbs([["Signal", SIGNAL + "/"], [h1, canonical]])] } })
    .on("section.pre", { element(e) { e.setInnerContent(body, { html: true }); } });
  return htmlResponse(rw.transform(shell));
}

async function signalStock(request, env, shell, raw, site) {
  const sym = raw.toUpperCase().replace(/\.NS$/, "");
  const d = await asset(env, request, `/c/${keyOf(sym)}.json`, 600_000);
  if (!d || !d.r) {
    const rw = headRewriter({ title: `${sym} — not on the screen · Signal`, desc: `${sym} is not among the NSE names Signal screens.`,
      canonical: null, site: "Signal", robots: "noindex,follow" })
      .on("section.pre", { element(e) { e.setInnerContent(`<p class="pre-k">Signal · Stock</p><h1 class="pre-h">${esc(sym)} is not on the screen</h1>
        <p class="pre-s">Signal screens ${esc(site ? site.universe : "about a thousand")} NSE names. Check the symbol, or <a href="/screen">browse the screen</a>.</p>`, { html: true }); } });
    return htmlResponse(rw.transform(shell), 404);
  }
  const r = d.r, name = r.name || sym, canonical = `${SIGNAL}/stock/${encodeURIComponent(sym)}`;
  /* The SAME title and description signal.js writes after it loads, so a
     crawler with JavaScript and one without read the same head. */
  const title = `${sym} — ${r.name || "Company"} · Signal`;
  const desc = `${r.name || sym}: price against its own year, trend, quality and value scores, `
    + `and FII/DII holding quarter on quarter from the company's own filings.`;
  const lead = `${name} (NSE: ${sym}${r.sector ? ", " + r.sector : ""}) closed at ${inr(r.price)}${r.last_date ? " on " + r.last_date : ""}, ${pct(r.from_high)} from its 52-week high.`
    + (r.roce != null ? ` ROCE ${r.roce}%.` : "") + (r.rev_cagr != null ? ` Revenue growth ${pct(r.rev_cagr)} a year.` : "");
  const ch = insight.changes(r, d.x, Object.assign({ today: istDate() }, d.ctx, { vsig: d.vsig }));
  const li = (xs) => xs.slice(0, 3).map((i) => `<li>${esc(i.t)} — ${esc(i.basis)}</li>`).join("");
  const body = `<p class="pre-k">Signal · Stock · ${esc(r.sector || "")}</p>
    <h1 class="pre-h">${esc(sym)} — ${esc(name)}</h1>
    <p class="pre-s">${esc(lead)}</p>
    <p class="pre-m">52-week range ${inr(r.low52)} – ${inr(r.high52)} · 50-day ${inr(r.sma50)} · 200-day ${inr(r.sma200)} · 1 month ${pct(r.r1m)}</p>
    ${ch.improved.length ? `<p class="pre-m"><b>Improved</b></p><ul class="pre-l">${li(ch.improved)}</ul>` : ""}
    ${ch.weakened.length ? `<p class="pre-m"><b>Weakened</b></p><ul class="pre-l">${li(ch.weakened)}</ul>` : ""}
    <p class="pre-m"><a href="${VISION}/company/${keyOf(sym)}">Open ${esc(sym)} in Vision — the full company research →</a></p>
    <p class="pre-n">Written by the server from the screen build${d.ctx && d.ctx.built_at ? ` of ${esc(day(d.ctx.built_at))}` : ""}. Descriptive, not a recommendation. The live page replaces it on load.</p>`;
  const rw = headRewriter({ title, desc, canonical, site: "Signal", robots: "index,follow,max-image-preview:large",
    ld: { "@context": "https://schema.org", "@graph": [
      { "@type": "WebPage", "@id": canonical, url: canonical, name: title, description: desc, isPartOf: { "@id": `${SIGNAL}/#website` },
        about: { "@type": "Corporation", name, tickerSymbol: `NSE:${sym}` } },
      crumbs([["Signal", SIGNAL + "/"], ["Screen", SIGNAL + "/screen"], [sym, canonical]])] } })
    .on("section.pre", { element(e) { e.setInnerContent(body, { html: true }); } });
  return htmlResponse(rw.transform(shell));
}

/* ─────────────────────────────── VISION ─────────────────────────────── */

const V_TITLE = "Vision — understand any Indian company in minutes";
const V_DESC = "Price, financials, ownership, events, technical structure and market context for ~1,000 NSE companies in one research workspace. Every number carries its source and its age. Educational research, not advice.";

async function visionShell(env, request) {
  const v = new URL(request.url); v.pathname = "/vision"; v.search = "";
  return env.ASSETS.fetch(new Request(v.toString(), { method: "GET", headers: request.headers }));
}

const vPage = (inner) => `<div class="ssr">${inner}
  <p class="ssr-n">This page was written by the server so it reads without JavaScript. The live workspace replaces it as soon as it loads. Educational research — not SEBI-registered advice.</p></div>`;

export async function visionHome(request, env) {
  const shell = await visionShell(env, request);
  const site = await asset(env, request, "/c/_site.json");
  const ve = (site && site.veod) || null, sig = (ve && ve.plans) || [];
  const top = (site && site.top) || [];
  const body = vPage(`<p class="ssr-k"><a href="${SIGNAL}/">← Signal</a> · Vision</p>
    <h1>Understand any Indian company in minutes.</h1>
    <p class="ssr-s">Price, financials, ownership, events, technical structure and market context — one research workspace for ${esc(site ? site.universe : "~1,000")} NSE companies. Signal finds what deserves attention; Vision shows why.</p>
    ${site && site.barometer ? `<p>Market barometer <b>${esc(site.barometer.score)}/100</b> (${esc(site.barometer.band || "")}). Past week: ${esc(site.week ? site.week.up : "—")} names rose, ${esc(site.week ? site.week.down : "—")} fell.</p>` : ""}
    ${sig.length ? `<h2>Plans for ${esc(ve.next_session || "the next session")}</h2><table><thead><tr><th>Company</th><th>Buy only</th><th>Stop</th><th>T1</th><th>T2</th><th>T3</th></tr></thead><tbody>
      ${sig.slice(0, 12).map((s) => `<tr><td><a href="/company/${keyOf(s.sym)}">${esc(s.sym)}</a></td><td>₹${Number(s.entry_low).toFixed(2)}–₹${Number(s.entry_high).toFixed(2)}</td><td>₹${Number(s.stop).toFixed(2)}</td><td>₹${Number(s.t1).toFixed(2)}</td><td>₹${Number(s.t2).toFixed(2)}</td><td>₹${Number(s.t3).toFixed(2)}</td></tr>`).join("")}</tbody></table>
      <p class="ssr-m">Conditional plans made after the close of ${esc(ve.session_date || "")}: never buy above the top of the range; fills are simulated. ${ve.mode === "paper" ? "Paper mode." : "Research mode — not validated."}</p>` : ""}
    ${top.length ? `<h2>Most-traded companies</h2><ul class="ssr-dir">${top.map((c) => `<li><a href="/company/${keyOf(c.sym)}">${esc(c.sym)}</a> <span>${esc(c.name || "")}</span></li>`).join("")}</ul>` : ""}`);
  const rw = headRewriter({ title: V_TITLE, desc: V_DESC, canonical: VISION + "/", site: "Vision", robots: "index,follow,max-image-preview:large",
    ld: { "@context": "https://schema.org", "@graph": [
      { "@type": "WebSite", "@id": `${VISION}/#website`, url: VISION + "/", name: "Vision", description: V_DESC, inLanguage: "en-IN",
        isPartOf: { "@id": `${SIGNAL}/#website` }, publisher: { "@id": `${SIGNAL}/#akshay` } }] } })
    .on("main#main", { element(e) { e.setInnerContent(body, { html: true }); } })
    .on("noscript", { element(e) { e.remove(); } });
  return htmlResponse(rw.transform(shell));
}

export async function visionCompany(request, env, raw) {
  const shell = await visionShell(env, request);
  const key = keyOf(decodeURIComponent(raw));
  const d = await asset(env, request, `/c/${key}.json`, 600_000);
  if (!d || !d.r) {
    const rw = headRewriter({ title: `${key} — not on the screen · Vision`, desc: `${key} is not among the NSE companies Vision covers.`, canonical: null, site: "Vision", robots: "noindex,follow" })
      .on("main#main", { element(e) { e.setInnerContent(vPage(`<h1>${esc(key)} is not on the screen</h1><p><a href="/">Search Vision's ~1,000 companies</a>.</p>`), { html: true }); } })
      .on("noscript", { element(e) { e.remove(); } });
    return htmlResponse(rw.transform(shell), 404);
  }
  const r = d.r, sym = r.sym, name = r.name || sym, canonical = `${VISION}/company/${key}`;
  const ctx = Object.assign({ today: istDate() }, d.ctx, { vsig: d.vsig });
  const mt = insight.matters(r, d.x, ctx), ch = insight.changes(r, d.x, ctx);
  const title = `${name} (${sym}) — what matters, what changed · Vision`;
  const desc = `${name}, NSE: ${sym}${r.sector ? " · " + r.sector : ""}. ${inr(r.price)} at the close of ${r.last_date || "the last build"}. `
    + mt.slice(0, 3).map((m) => `${m.k} ${m.v}`).join(" · ") + ". Sourced figures, not advice.";
  const list = (h, xs) => xs.length ? `<h3>${h}</h3><ul>${xs.map((i) => `<li><b>${esc(i.t)}</b> — ${esc(i.basis)} <small>(${esc(i.src)})</small></li>`).join("")}</ul>` : "";
  const body = vPage(`<p class="ssr-k"><a href="${SIGNAL}/">← Signal</a> · <a href="/">Vision</a> · ${esc(r.sector || "")}</p>
    <h1>${esc(name)} <span>${esc(sym)}</span></h1>
    <p class="ssr-s"><b>${inr(r.price)}</b> ${pct(r.r1d)} · close of ${esc(r.last_date || "the last build")} · 52-week ${inr(r.low52)} – ${inr(r.high52)} · 50-day ${inr(r.sma50)} · 200-day ${inr(r.sma200)}</p>
    <h2>What matters</h2><dl>${mt.map((m) => `<dt>${esc(m.k)}</dt><dd>${esc(m.v)}${m.sub ? ` — ${esc(m.sub)}` : ""} <small>(${esc(m.src)})</small></dd>`).join("")}</dl>
    <h2>What changed</h2>${list("Improved", ch.improved)}${list("Weakened", ch.weakened)}${list("Worth weighing", ch.watch)}${list("Events", ch.events)}
    ${!ch.improved.length && !ch.weakened.length ? "<p>No measured change crossed its threshold since the last filing and build.</p>" : ""}
    <p><a href="${SIGNAL}/stock/${encodeURIComponent(sym)}">${esc(sym)} on Signal — the published record →</a></p>`);
  const rw = headRewriter({ title, desc, canonical, site: "Vision", robots: "index,follow,max-image-preview:large",
    ld: { "@context": "https://schema.org", "@graph": [
      { "@type": "WebPage", "@id": canonical, url: canonical, name: title, description: desc, isPartOf: { "@id": `${VISION}/#website` },
        dateModified: d.ctx && d.ctx.built_at, about: { "@type": "Corporation", name, tickerSymbol: `NSE:${sym}` } },
      crumbs([["Vision", VISION + "/"], [name, canonical]])] } })
    .on("main#main", { element(e) { e.setInnerContent(body, { html: true }); } })
    .on("noscript", { element(e) { e.remove(); } });
  return htmlResponse(rw.transform(shell));
}
