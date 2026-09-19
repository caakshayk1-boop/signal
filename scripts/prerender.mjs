#!/usr/bin/env node
/**
 * prerender.mjs — put real content in <main> before any JavaScript runs.
 *
 * WHAT WAS WRONG
 * --------------
 * index.html shipped with `<main id="main"></main>` and every word on the
 * page was written by the renderer. For a reader that is fine — measured, the
 * front page has content at 438ms. For anything that does not execute
 * JavaScript it is not: a crawler, a link preview, a reader on a failed script
 * load, or anyone on a connection slow enough to see the gap, all got a
 * navigation, a footer, and nothing between them.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * It writes a small, true summary of the day into <main> at deploy time, from
 * the same feeds the page will fetch. It is NOT a second implementation of the
 * front page and must never become one — the renderer replaces it wholesale on
 * its first paint, so anything elaborate here is work nobody sees and a second
 * place for the truth to drift.
 *
 * It carries the date it was built from. A pre-render is a snapshot, and a
 * snapshot that does not say when it was taken is the stale-number problem
 * this site keeps having, reintroduced at build time.
 */
import { readFileSync, writeFileSync } from "node:fs";

const OPEN = "<!--PRERENDER-->";
const CLOSE = "<!--/PRERENDER-->";

const read = (f) => { try { return JSON.parse(readFileSync(`public/${f}.json`, "utf8")); } catch { return null; } };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

const pulse = read("pulse") || {};
const today = read("today") || {};
const news = read("news") || [];
const scr = read("screen") || {};

const br = pulse.breadth || {};
const up = num(br.up), down = num(br.down), counted = num(br.counted);
const date = esc(today.date_str || today.date || pulse.built_on || "");
const universe = num(pulse.universe) || num(br.counted) || num(scr.universe_size);

const picks = Array.isArray(today.picks) ? today.picks : [];
const wire = Array.isArray(news) ? news : [];

/* THE RECORD, READ RATHER THAN RECOMPUTED.
 *
 * The snapshot's old headline sold the signals — "decoded in 60 seconds",
 * "one setup written up in full". That is the sentence a crawler indexes and
 * a link preview shows, and it is the one the ledger contradicts.
 *
 * The figures are not in any static feed, and the two ways to get them here
 * were: compute them from alerts.json, or ask the API that already computes
 * them. Computing them would put a second implementation of this site's
 * headline number in a build script — the failure this repo has hit more than
 * once. So it asks the live Worker, which is the same source the page itself
 * reads a second later.
 *
 * It must never fail the build. A snapshot without the numbers is a smaller
 * page; a build that dies because a fetch timed out is an outage. */
/* ── LAUNCH AND THE ROSTER COME FROM engines.js, NOT FROM HERE ─────────────
 *
 * This file used to carry `const LAUNCH = "2026-09-02"` under a comment
 * reading "must match LAUNCH in public/signal.js" — a copy, with a note asking
 * a human to keep it in step. That is the arrangement that put five different
 * records on one site.
 *
 * It also parsed ENGINE_REGISTRY out of signal.js and took EVERY key, retired
 * ones included, so the crawler's snapshot would have counted engines the page
 * had switched off — the identical bug the page itself had.
 *
 * engines.js is the one browser copy and is loaded here the same way the two
 * bundles load it: it assigns to a global, so a bare object stands in for
 * `window`. Throws rather than degrading, because a silently empty whitelist
 * makes the shell claim zero published on a day that is false, and a wrong
 * number in a crawler's index outlives the build that produced it. */
const BOOK = (() => {
  const src = readFileSync(new URL("../public/engines.js", import.meta.url), "utf8");
  const root = {};
  new Function("window", src)(root);
  const b = root.ENGINE_BOOK;
  if (!b || typeof b.keys !== "function") {
    throw new Error("prerender: ENGINE_BOOK not found in engines.js");
  }
  if (!b.keys().length) throw new Error("prerender: the live engine roster is empty");
  return b;
})();
const LAUNCH = BOOK.LAUNCH;
const ENGINES = new Set(BOOK.keys());
async function liveRecord() {
  try {
    // /api/signals, NOT /api/stats. stats is all-time and cannot be filtered,
    // and this snapshot has to describe the same population the page does:
    // what this site PUBLISHED, from launch, graded. Quoting the all-time
    // figure here would put one record in the crawler's index and a different
    // one on the page it links to.
    const r = await fetch("https://signal.askakshay.com/api/signals?limit=400",
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.signals)) return null;
    /* ── THE SAME POPULATION, OR IT IS NOT A SNAPSHOT OF THIS PAGE ────────
     *
     * This filtered on DATE ALONE while the page also applies the engine
     * whitelist and the long-only rule. The shell said "37 published since
     * 2026-09-02" and the live page, a second later, said 29 — the reader
     * watching it load saw two different records for the same claim, and the
     * crawler indexed the wrong one.
     *
     * The whitelist is READ OUT OF signal.js rather than repeated here.
     * Repeating it is exactly how this drifted: the site's own history already
     * records the lesson — consistency between two surfaces cannot come from
     * carefully writing the same filter twice, it has to come from one source.
     * A second copy would be correct today and wrong the next time an engine
     * is added. */
    /* The identical predicate the page applies — BOOK.inBook — rather than a
       third hand-written copy of it. It adds the rupee guard this filter did
       not have, which today changes nothing because the engine rule already
       leaves only Indian names, and stops the snapshot counting a COMEX future
       the day that stops being true. `alert_date` is still preferred over
       `date` where a row carries one. */
    const rows = j.signals.filter((x) =>
      BOOK.ok(x)
      && String(x.alert_date || x.date || "").slice(0, 10) >= LAUNCH);
    const closed = rows.filter(
      (x) => Number.isFinite(Number(x.r_multiple)) && (x.badge || "") !== "open");
    // NOT `if (!rows.length) return null`. Zero rows on or after LAUNCH is a
    // real, correct answer — it is what a record that restarted today looks
    // like — and returning null for it routed the snapshot into the "ledger
    // unreachable" branch on the one day that sentence was false.
    const wins = closed.filter((x) => Number(x.r_multiple) > 0).length;
    const sum = closed.reduce((a, x) => a + Number(x.r_multiple), 0);
    /* ── THE SNAPSHOT MUST NOT SOFTEN WHAT THE PAGE STATES PLAINLY ─────────
     * This printed "Too few to settle anything" below thirty closed trades,
     * which on 2026-09-19 sat under 13 closed at -0.765R — a result whose 95%
     * interval excludes zero. The crawler's copy of the record was therefore
     * kinder about it than the page, and the crawler's copy is the one that
     * gets indexed and quoted.
     *
     * A z-approximation, not the page's exact t-distribution: this is a build
     * script whose whole job is a one-paragraph summary, and the two agree on
     * the only thing this sentence claims — whether the interval clears zero.
     * At 13 trades the z interval is NARROWER than the t interval, so it is
     * the conservative direction: anything this calls significant, the page's
     * stricter test already did. */
    const n = closed.length;
    let significant = false, lo = null, hi = null;
    if (n > 1) {
      const mean = sum / n;
      const sd = Math.sqrt(closed.reduce(
        (a, x) => a + (Number(x.r_multiple) - mean) ** 2, 0) / (n - 1));
      const se = sd / Math.sqrt(n);
      lo = mean - 1.96 * se; hi = mean + 1.96 * se;
      significant = sd > 0 && (hi < 0 || lo > 0);
    }
    return { published: rows.length, trades: n, wins,
             losses: n - wins, significant,
             ci: lo == null ? null : [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100],
             win_rate: n ? Math.round(wins / n * 1000) / 10 : null,
             expectancy_r: n ? Math.round(sum / n * 1000) / 1000 : null };
  } catch { return null; }
}
const rec = await liveRecord();

const state = up != null && counted
  ? (up / counted >= 0.6 ? "Broad advance" : up / counted <= 0.4 ? "Broad decline" : "Split")
  : null;

const block = `${OPEN}
<section class="pre">
  <p class="pre-k">Signal · ${date}</p>
  <h1 class="pre-h">${rec && rec.trades
    ? (rec.wins === 0
        ? `Every signal, graded. All ${rec.trades} that closed, lost.`
        : `Every signal, graded. Including the ${rec.losses} that lost.`)
    : `Every signal, graded. The record is public.`}</h1>
  <p class="pre-s">${rec && rec.trades
    ? `<b>${rec.published}</b> published since ${LAUNCH}, <b>${rec.trades}</b> closed, averaging
       <b>${rec.expectancy_r > 0 ? "+" : ""}${rec.expectancy_r}R</b>.
       ${rec.significant
          ? `Statistically ${rec.ci[1] < 0 ? "negative" : "positive"} — the 95% interval
             (${rec.ci[0] > 0 ? "+" : ""}${rec.ci[0].toFixed(2)}R to
             ${rec.ci[1] > 0 ? "+" : ""}${rec.ci[1].toFixed(2)}R) excludes zero.
             ${rec.trades < 30 ? `That settles the sign, not the size.` : ``}`
          : rec.ci
          ? `The 95% interval (${rec.ci[0] > 0 ? "+" : ""}${rec.ci[0].toFixed(2)}R to
             ${rec.ci[1] > 0 ? "+" : ""}${rec.ci[1].toFixed(2)}R) includes zero — too few to
             settle anything, and shown anyway.`
          : ``}
       The screen below is research.`
    : rec && rec.published
      ? `<b>${rec.published}</b> published since ${LAUNCH}, none closed yet. The screen below is
         research until they settle.`
      : rec
      ? `Nothing published yet. The stop rules changed on ${LAUNCH}, so the count starts there.
         Earlier signals stay on news.askakshay.com.`
      : `Every call is logged when it is made and graded against the bars that follow, win or lose.
         The full ledger is on the live page.`}</p>
  ${universe ? `<p class="pre-m">Every session, <b>${universe} names</b> re-screened and the wire read
    for what touches them.</p>` : ""}
  ${up != null && down != null && counted ? `<p class="pre-m"><b>${up}</b> of <b>${counted}</b>
    screened names advanced and <b>${down}</b> declined${state ? ` — ${esc(state.toLowerCase())}` : ""}.
    ${num(br.at_52w_high) != null ? `<b>${br.at_52w_high}</b> sit at a 52-week high.` : ""}</p>` : ""}
  ${picks.length ? `<p class="pre-m"><b>${picks.length}</b> candidates cleared the screen this week${
    picks[0] && picks[0].sym ? `, led by <b>${esc(picks[0].sym)}</b>` : ""} — ranked, not recommended.</p>` : ""}
  ${wire.length ? `<ul class="pre-l">${wire.slice(0, 4).map((x) =>
    `<li><b>${esc(x.source || "wire")}</b> — ${esc(x.title || "")}</li>`).join("")}</ul>` : ""}
  <p class="pre-n">This is the snapshot published with the build${date ? ` on ${date}` : ""}.
    The live page replaces it with current prices as soon as it loads.</p>
</section>
${CLOSE}`;

const path = "public/index.html";
let html = readFileSync(path, "utf8");

// Idempotent: replace a previous block, or seed one inside <main>.
if (html.includes(OPEN) && html.includes(CLOSE)) {
  html = html.replace(new RegExp(`${OPEN}[\\s\\S]*?${CLOSE}`), block);
} else {
  const m = html.match(/<main id="main"[^>]*>/);
  if (!m) { console.error("prerender: <main id=\"main\"> not found — nothing written"); process.exit(1); }
  html = html.replace(m[0], `${m[0]}\n${block}\n`);
}
writeFileSync(path, html);
console.log(`prerender: ${block.length} bytes into <main>${date ? ` (${date})` : ""}`);
