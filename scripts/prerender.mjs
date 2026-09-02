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
async function liveRecord() {
  try {
    const r = await fetch("https://signal.askakshay.com/api/stats",
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok && j.headline && j.headline.trades ? j : null;
  } catch { return null; }
}
const rec = await liveRecord();

const state = up != null && counted
  ? (up / counted >= 0.6 ? "Broad advance" : up / counted <= 0.4 ? "Broad decline" : "Split")
  : null;

const block = `${OPEN}
<section class="pre">
  <p class="pre-k">Signal · ${date}</p>
  <h1 class="pre-h">${rec
    ? `Every signal, graded. Including the ${rec.headline.losses} that lost.`
    : `Every signal, graded. The record is public.`}</h1>
  <p class="pre-s">${rec
    ? `<b>${rec.totals.closed}</b> closed trades, <b>${rec.headline.win_rate}%</b> of them winners,
       averaging <b>${rec.headline.expectancy_r > 0 ? "+" : ""}${rec.headline.expectancy_r}R</b> a trade.
       ${rec.headline.expectancy_r < 0
         ? `That is a losing record and it is published first, because a record shown only after a
            good month is not a record. The screen below is research on that basis.`
         : `The screen below is the working behind it.`}`
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
