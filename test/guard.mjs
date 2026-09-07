#!/usr/bin/env node
/**
 * guard.mjs — static checks for the classes of mistake actually made in this
 * repo, not a generic linter.
 *
 * Every rule here exists because the fault it catches SHIPPED. A rule with no
 * incident behind it is a guess about what might go wrong, and it costs the
 * same to run as one that has already saved you.
 *
 *   node test/guard.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const JS = readFileSync("public/signal.js", "utf8");
const CSS = readFileSync("public/signal.css", "utf8");
const HTML = readFileSync("public/index.html", "utf8");

let fails = 0, checks = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) return;
  fails++;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/* ── 1. A COMPARISON WHOSE BRANCHES ARE IDENTICAL ────────────────────────────
 * The incident: a stop-rule simulation scored one branch as
 *     return long ? (x.c <= r.sl ? -1 : -1) : -1;
 * Both arms of that inner ternary are -1, so the rule under test could never
 * differ from the rule it was being compared against, and it published a
 * finding of +0.071R at t=2.53 that was pure artefact. Nothing failed. The
 * numbers looked plausible. It was caught days later by measuring the tail.
 *
 * Any ternary whose two arms are textually identical is either a typo or dead
 * code; there is no third case. */
{
  const re = /\?\s*([^?:;()]{1,40}?)\s*:\s*([^?:;()]{1,40}?)\s*([)\];,])/g;
  const hits = [];
  let m;
  for (const [label, src] of [["signal.js", JS]]) {
    while ((m = re.exec(src))) {
      const a = m[1].trim(), b = m[2].trim();
      if (a && a === b) hits.push(`${label}:${lineOf(src, m.index)}  ? ${a} : ${b}`);
    }
  }
  ok("no ternary with identical branches", hits.length === 0, hits.slice(0, 5));
}

/* ── 2. EVERY INTERNAL LINK RESOLVES TO A REAL ROUTE ─────────────────────────
 * The incident: the engine roster linked nowhere, and a route was added to the
 * router without being added to the nav. A link to a route that does not exist
 * renders the front page and looks like the click was ignored. */
{
  const routes = new Set([...JS.matchAll(/R\['(\/[a-z0-9/:-]*)'\]\s*=/g)].map(x => x[1]));
  ok("the router declares routes", routes.size > 5, routes.size);
  const hrefs = new Set();
  for (const src of [JS, HTML]) {
    for (const x of src.matchAll(/href="(#?\/[a-z0-9/-]*)"/g)) hrefs.add(x[1]);
  }
  const bad = [...hrefs]
    .map(h => h.replace(/^#/, ""))
    .filter(h => h !== "/" && !routes.has(h) && !h.startsWith("/api"));
  ok("every internal link points at a declared route", bad.length === 0, bad);
}

/* ── 3. NO ROUTE IS UNREACHABLE ──────────────────────────────────────────────
 * The mirror of rule 2: a route nothing links to is a route nobody finds. */
{
  const routes = [...JS.matchAll(/R\['(\/[a-z0-9/:-]*)'\]\s*=/g)].map(x => x[1]);
  const linked = new Set();
  for (const src of [JS, HTML]) {
    for (const x of src.matchAll(/href="#?(\/[a-z0-9/-]*)"/g)) linked.add(x[1]);
    for (const x of src.matchAll(/data-route="(\/[a-z0-9/-]*)"/g)) linked.add(x[1]);
    for (const x of src.matchAll(/go\('(\/[a-z0-9/-]*)'\)/g)) linked.add(x[1]);
    for (const x of src.matchAll(/\['(\/[a-z0-9/-]*)',\s*'/g)) linked.add(x[1]);   // CMD_ROUTES
  }
  const orphans = routes.filter(r => !linked.has(r) && !r.includes(":"));
  ok("no route is unreachable from any link", orphans.length === 0, orphans);
}

/* ── 4. EVERY CSS CLASS THE JS EMITS EXISTS IN THE STYLESHEET ────────────────
 * The incident: a refactor renamed a row's element and the style that targeted
 * the old one stayed behind, so the element rendered unstyled and nothing
 * failed. Only checks the site's own prefixes — utility and state classes
 * built by string concatenation are excluded because they cannot be read
 * statically. */
{
  const PREFIXES = ["ef-", "scr-ins", "insti-", "isc", "ispark", "isp-", "xr", "xd", "ia-"];
  const emitted = new Set();
  for (const x of JS.matchAll(/class="([a-z0-9 _-]+)"/g)) {
    for (const c of x[1].split(/\s+/)) {
      if (c && PREFIXES.some(p => c.startsWith(p))) emitted.add(c);
    }
  }
  const missing = [...emitted].filter(c => !CSS.includes("." + c));
  ok("every prefixed class the renderer emits is styled", missing.length === 0, missing);
}

/* ── 5. THE STYLESHEET IS BALANCED ───────────────────────────────────────────
 * Appending a block with one brace too few silently swallows every rule after
 * it, and the page keeps rendering. */
{
  const strip = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const o = (strip.match(/{/g) || []).length, c = (strip.match(/}/g) || []).length;
  ok("css braces balance", o === c, { open: o, close: c });
}

/* ── 6. NO TWO ADJACENT METRIC ROWS ARE THE SAME EXPRESSION ──────────────────
 * The incident: an IPO panel printed "Since listing +225.20%" and "Move after
 * listing +225.22%" one under the other — the same quantity computed two ways
 * and presented as two facts. The static form of that fault is the same
 * variable rendered twice inside one template block. */
{
  const dup = [];
  for (const blk of JS.matchAll(/<div class="yoy">([\s\S]{0,1400}?)<\/div>/g)) {
    const vars = [...blk[1].matchAll(/\$\{[^}]*?\b([a-z_][a-zA-Z0-9_]{2,})\s*==\s*null/g)].map(x => x[1]);
    const seen = new Set(), rep = new Set();
    for (const v of vars) (seen.has(v) ? rep : seen).add(v);
    if (rep.size) dup.push(`${lineOf(JS, blk.index)}: ${[...rep].join(", ")}`);
  }
  ok("no metric block renders the same value twice", dup.length === 0, dup.slice(0, 4));
}

/* ── 7. THE PRERENDER MARKERS SURVIVE ────────────────────────────────────────
 * scripts/prerender.mjs writes between these. If an edit removes one, the
 * script silently writes nothing and the shell ships with stale copy. */
{
  ok("prerender markers are intact",
     HTML.includes("<!--PRERENDER-->") && HTML.includes("<!--/PRERENDER-->"));
}

/* ── 8. NOTHING CLAIMS A NUMBER THE FEED CANNOT CARRY ────────────────────────
 * The incident: an IPO panel read Number(r.price_high) off rows whose feed has
 * no price_high, so all sixty said the value "could not be read". Fields the
 * renderer reads off a feed must exist in that feed. */
{
  const feed = JSON.parse(readFileSync("public/ipo.json", "utf8"));
  const listedFields = new Set(Object.keys((feed.recent_listed || [{}])[0] || {}));
  const seg = (JS.match(/const ipoDetail[\s\S]{0,2200}?\n    };/) || [""])[0];
  const read = [...seg.matchAll(/\br\.([a-z_]+)/g)].map(x => x[1]);
  const absent = [...new Set(read)].filter(f => !listedFields.has(f));
  ok("the listing panel only reads fields recent_listed actually has",
     absent.length === 0, absent);
}

console.log(fails
  ? `\n${fails} of ${checks} guard checks FAILED`
  : `\n${checks}/${checks} guard checks pass`);
process.exit(fails ? 1 : 0);
