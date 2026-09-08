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
               "buoy"];

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
console.log(`feeds: ${changed} updated, ${kept} unchanged, ${failed} unreachable`);
