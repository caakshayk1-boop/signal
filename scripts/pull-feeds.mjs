#!/usr/bin/env node
/**
 * pull-feeds.mjs — fetch the mirrored data feeds before a deploy.
 *
 * THE BUG THIS CLOSES
 * -------------------
 * The feeds are static files under public/, served by the Worker's asset
 * binding. sync-data.yml commits fresh copies into this repo twice a day —
 * and committing does not deploy anything. The live site only ever changed
 * when someone ran `wrangler deploy` from a laptop, which uploads THAT
 * laptop's public/ directory.
 *
 * So the site served whatever the last deploying machine happened to have.
 * On the morning this was written every feed on signal.askakshay.com was 31
 * hours old while the upstream repo held data from an hour earlier, and each
 * deploy that day faithfully re-published the stale copies over the fresh
 * ones the sync had committed.
 *
 * Running this before every deploy makes the deploy carry current data
 * regardless of who runs it or what their working copy contains. It is wired
 * into `npm run deploy`, so it is not something anyone has to remember.
 *
 * A feed that does not answer, or answers with something that is not JSON,
 * leaves the committed copy alone. Shipping yesterday's screen is a bad day;
 * shipping a 404 page named screen.json is a broken site.
 */
import { writeFileSync, readFileSync } from "node:fs";

const RAW = "https://raw.githubusercontent.com/caakshayk1-boop/trading-dashboard/main/docs";
const FEEDS = ["alerts", "conviction", "data-health", "edition", "ipo",
               "mandate", "news", "pulse", "screen", "today",
               // BUOY's forward scan. Written by scan_buoy.py in the
               // trading-dashboard repo; absent until that job has run, and a
               // missing feed leaves the committed copy alone rather than
               // replacing it with a 404 page named buoy.json.
               // buoy was mirrored and read by NOTHING: R['/buoy'] redirects to
               // /research and no page fetches buoy.json. A feed nobody reads
               // is dead weight that rots into a wrong answer the day somebody
               // wires it up, so it is not mirrored. scan_buoy.py still writes
               // it upstream; add it back here the day a page reads it.
               "alerts_log", "research",
               // SWOT alone, three per quadrant — 0.6MB against the 4.1MB
               // detail file the brief will not load. This is the only place
               // the brief can get Strengths/Weaknesses/Opportunities/Threats.
               "swot",
               // THE LITE TABLE, WHICH WAS NEVER SYNCED. Every light route on
               // the site reads screen-lite.json, and it was absent from this
               // list — so it was frozen at whatever commit last happened to
               // carry it. Measured tonight: screen.json served 989 rows with
               // 325 Ahimsa constituents while screen-lite.json, on the same
               // origin, served 748 rows and zero. Home and the light routes
               // were rendering a universe that no longer existed.
               "screen-lite",
               // engines and funds were in sync-data.yml's list and not in
               // this one. TWO LISTS FOR ONE JOB, and they had drifted in both
               // directions — this file also carried buoy and swot, which that
               // one lacked. Whichever ran last decided what the site served.
               "engines", "funds",
               // THE THREE NEW FEEDS, ADDED WITH THE PAGES THAT READ THEM.
               // All three were sitting in public/ committed by hand and
               // absent from this list — which is the exact fault this file's
               // docstring describes, reproduced three more times. A feed that
               // is served but never pulled does not fail; it FREEZES, and a
               // frozen barometer keeps announcing a market stage that ended
               // months ago with a fresh timestamp beside it.
               //
               //   barometer    — the daily market reading and its outcome
               //                  history; written by barometer.py at 13:45.
               //   seasonality  — eleven years of monthly records for 626
               //                  names; the /stock page and /map both read it.
               //   weekly_reads — Saturday's seven studies.
               "barometer", "seasonality", "weekly_reads",
               // The regime: what kind of market this is, and what the closed
               // ledger says happened in it. Written by regime.py.
               "regime"];

const stampOf = (o) => {
  if (!o || Array.isArray(o)) return null;
  for (const k of ["generated_at", "built_at", "built_on", "date", "build_id"]) {
    if (o[k]) return String(o[k]);
  }
  return null;
};

let changed = 0, kept = 0, failed = 0;
for (const f of FEEDS) {
  const path = `public/${f}.json`;
  try {
    const r = await fetch(`${RAW}/${f}.json`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    JSON.parse(text);                        // a 404 page is still a 200-length string
    let before = null;
    try { before = readFileSync(path, "utf8"); } catch { /* first pull */ }
    if (before === text) { kept++; console.log(`  same  ${f}`); continue; }
    writeFileSync(path, text);
    changed++;
    let stamp = "";
    try { stamp = stampOf(JSON.parse(text)) || ""; } catch { /* array feed */ }
    console.log(`  NEW   ${f}${stamp ? `  ${stamp.slice(0, 19)}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`  keep  ${f} — ${String(e.message || e)} (committed copy left in place)`);
  }
}
/* Vision's signals live in feeds/, not docs/, upstream — see sync-data.yml's
   "Fetch Vision's signals" step for why. Same rule: only a valid feed that
   says ok replaces the committed copy, and a 404 before the first scan is a
   state, not a failure. */
const EXTRA = [["vision_signals", "https://raw.githubusercontent.com/caakshayk1-boop/trading-dashboard/main/feeds/vision_signals.json"]];
for (const [f, url] of EXTRA) {
  const path = `public/${f}.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text(), d = JSON.parse(text);
    if (!d || !d.ok || !Array.isArray(d.history)) throw new Error("not a valid signals feed");
    let before = null;
    try { before = readFileSync(path, "utf8"); } catch { /* first pull */ }
    if (before === text) { kept++; console.log(`  same  ${f}`); continue; }
    writeFileSync(path, text); changed++;
    console.log(`  NEW   ${f}  ${String(d.generated_at || "").slice(0, 19)}`);
  } catch (e) {
    failed++;
    console.log(`  keep  ${f} — ${String(e.message || e)} (committed copy, if any, left in place)`);
  }
}
console.log(`feeds: ${changed} updated, ${kept} unchanged, ${failed} unreachable`);
