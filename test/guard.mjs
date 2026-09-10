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
const GEMS = readFileSync("public/gems.js", "utf8");
const IDX = readFileSync("src/index.js", "utf8");

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
  /* /404 is deliberately unlinked: it is what routeOf() falls back to when a
   * path matches nothing, and a link TO it would be a link to a page that
   * announces itself as missing. Reached by mistyping, never by clicking. */
  /* Two routes are deliberately unlinked and both are aliases rather than
   * destinations: /404 is what routeOf() falls back to when a path matches
   * nothing, and /buoy is a legacy address kept working for links shared
   * before /research existed. Linking to either would be linking to a
   * redirect. */
  const ALIAS = new Set(["/404", "/buoy"]);
  const orphans = routes.filter(r => !linked.has(r) && !r.includes(":") && !ALIAS.has(r));
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
  /* A class on a <template> is the one exception, and it is a real one rather
   * than a convenience: template content is an inert DocumentFragment that is
   * never in the document tree, never matched by a selector and never laid
   * out. Requiring a style for it is the rule asking the wrong question. */
  const TEMPLATE_ONLY = new Set(["xd-src"]);
  const missing = [...emitted].filter(c => !TEMPLATE_ONLY.has(c) && !CSS.includes("." + c));
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

/* ── 9. NO ORPHANED COMMENT FRAGMENT INSIDE A TEMPLATE LITERAL ──────────────
 * The incident, and the worst one so far because readers saw it: editing the
 * FIRST line of a `${/* ... *\/''}` block left the rest of the old comment
 * behind. The orphan is no longer inside a comment — it is raw text in a
 * template literal — so nine lines of source commentary rendered on the live
 * brief page as body copy. It parsed, it deployed, and every existing check
 * passed, because a string containing an asterisk is perfectly valid code.
 *
 * Every `*\/''}` terminator must be reachable from a `${/*` opener with no
 * intervening `*\/`. Anything else is an orphan. */
{
  const orphans = [];
  const lines = JS.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\*\/''\}/.test(lines[i])) continue;
    let open = false;
    for (let j = i; j >= 0 && i - j < 60; j--) {
      if (j < i && /\*\/''\}/.test(lines[j])) break;      // hit a previous terminator first
      if (/\$\{\s*\/\*/.test(lines[j])) { open = true; break; }
    }
    if (!open) orphans.push(`signal.js:${i + 1}`);
  }
  ok("every template-literal comment terminator has an opener", orphans.length === 0, orphans);
}

/* ── 11. A COMPONENT OWNS ITS CLASS NAMESPACE ───────────────────────────────
 * The incident: the radar's node card used `rc-t`, `rc-b`, `rc-m`. `rc-*` was
 * ALREADY the return-chart component's namespace, so `.rc-t` picked up that
 * chart's tooltip padding (9px 11px), which inflated the row, overlapped its
 * siblings, and pushed the stock TICKER out of every card in the signal
 * universe strip. The cards rendered. The tests passed. The names were gone.
 *
 * A whole-file "defined twice" rule is useless here — this stylesheet layers
 * .bar, .tabs and .brand across it deliberately, and a rule that cries wolf
 * gets ignored. So the check is narrow and true: every class the RADAR emits
 * must live in the radar's own namespace (rd- / rdc-). A component that names
 * its own parts cannot collide with one that already exists. */
{
  const seg = (JS.match(/const radarCardInner[\s\S]*?const wireRadar/) || [""])[0]
            + (JS.match(/const radarSvg[\s\S]*?const radarCardInner/) || [""])[0];
  const emitted = new Set();
  for (const x of seg.matchAll(/class="([a-z0-9 _-]+)"/g)) {
    for (const c of x[1].split(/\s+/)) if (c) emitted.add(c);
  }
  const OWN = /^(rd-|rdc-|is-|up$|dn$|warn$|flat$)/;
  const foreign = [...emitted].filter(c => !OWN.test(c));
  ok("the radar only emits classes in its own namespace", foreign.length === 0, foreign);
}

/* ── 12. Number(null) IS 0, AND 0 IS FINITE ────────────────────────────────
 * The incident: gems.js grew its own numeric coercion helper —
 *     const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; }
 * which looks exhaustive and is not. Number(null), Number('') and Number([])
 * are all 0, and 0 passes isFinite — so every null numeric in every feed
 * became a real zero. A signal whose target3 was null drew a price level at
 * ₹0, which pulled the ladder's scale minimum to zero, squeezed the real
 * levels into the right-hand third of the drawing, and printed "T3 is 18.7R"
 * for a target that does not exist. It renders, it does not throw, and no
 * test that checks a level is PRESENT can see it.
 *
 * signal.js already knew this — its own lvl() and price() guard null first,
 * and price() carries the comment saying why. The bug arrived by writing a
 * fresh helper in a new file rather than by forgetting the lesson.
 *
 * So the rule is aimed at exactly that: a HELPER whose whole job is "give me
 * a number or null" must reject null/''/undefined before it coerces. It
 * deliberately does not flag ordinary call sites, which carry their own
 * context — a rule that fires twenty-one times on working code is a rule
 * everyone learns to skip. */
{
  const bad = [];
  for (const [file, code] of [["public/signal.js", JS], ["public/gems.js", GEMS]]) {
    // Arrow-function bodies that both coerce with Number() and can return null:
    // the "number or nothing" helper shape.
    for (const m of code.matchAll(/=>\s*\{([\s\S]{0,320}?)\}/g)) {
      const body = m[1];
      if (!/Number\.isFinite\s*\(/.test(body)) continue;
      if (!/\bnull\b/.test(body)) continue;                 // must be able to return null
      if (!/Number\s*\(/.test(body)) continue;              // must coerce
      const guards = /(==|===)\s*null|!=\s*null|!==\s*null|===\s*undefined|undefined\s*===|===\s*''|typeof\s+\w+\s*===/.test(body);
      if (!guards) bad.push(`${file}:${lineOf(code, m.index)}`);
    }
  }
  ok("a number-or-null helper rejects null before it coerces", bad.length === 0, bad);
}

/* ── 13. THE WORKER'S PAGE LIST MUST MATCH THE APP'S ROUTES ────────────────
 * src/index.js now returns a real 404 for any path that is not a known page,
 * which fixed the soft-404 (every typo answered 200 and told crawlers it was
 * a page). The cost is a SECOND list of routes: the Worker cannot import the
 * 500 KB client bundle to ask it, so PAGES is written out by hand.
 *
 * A list maintained in two places drifts, and this one drifts silently in the
 * worst direction — add R['/foo'] to signal.js, forget PAGES, and /foo now
 * 404s in production while working perfectly in every local test that loads
 * the app directly. So the two are compared here. */
{
  const routes = new Set(
    [...JS.matchAll(/R\['(\/[a-z0-9:/-]*)'\]\s*=/g)].map((m) => m[1])
  );
  const pages = new Set(
    [...(IDX.match(/const PAGES = new Set\(\[([\s\S]*?)\]\)/) || ["", ""])[1]
      .matchAll(/"([^"]+)"/g)].map((m) => m[1])
  );
  // /stock/:sym is handled by a prefix test in the Worker, not by the list.
  const dynamic = (r) => r.includes(":");
  /* /404 is the router's FALLBACK, not an address. It must never appear in
   * PAGES — listing it would make /404 a page that returns 200, which is the
   * soft-404 this whole fix exists to remove. */
  const missing = [...routes].filter((r) => !dynamic(r) && r !== "/404" && !pages.has(r));
  const extra = [...pages].filter((p) => p !== "/gems" && !routes.has(p));
  ok("every app route is in the Worker's PAGES list (else it 404s live)",
     missing.length === 0, missing);
  ok("the Worker's PAGES list has no route the app cannot render",
     extra.length === 0, extra);
}

/* ── EVERY FEED THE APP FETCHES MUST BE MIRRORED ─────────────────────────────
 * The incident: signal.js fetches /research.json and /alerts_log.json, and
 * sync-data.yml's feed list contained neither. Both files existed in public/,
 * so nothing 404'd and nothing looked broken — they were simply frozen at
 * whatever was last committed by hand, 2026-09-08, while research.yml upstream
 * rewrote them twice a day.
 *
 * A missing feed announces itself: the fetch fails and the page says so. A
 * feed that is present but never refreshed is the worse failure, because the
 * page renders normally and every number on it is a fact about last week.
 *
 * This is the same shape as docs/screen.json needing an allow-list entry in
 * three separate files upstream. A payload is not published because it is
 * written; it is published when every hop in front of it names it. */
{
  const SYNC = readFileSync(".github/workflows/sync-data.yml", "utf8");
  const feeds = new Set(
    ((SYNC.match(/^\s*FEEDS="([^"]+)"/m) || ["", ""])[1]).split(/\s+/).filter(Boolean)
  );
  ok("sync-data.yml declares a FEEDS list guard.mjs can read", feeds.size > 0);

  // A feed is legitimately absent from FEEDS in exactly two cases: the Worker
  // serves it from Turso at request time, or a workflow IN THIS REPO builds it
  // (institutional.json is built by institutional.yml from exchange filings —
  // mirroring it would give the same number two sources of truth).
  //
  // The second set is read off the workflows rather than listed here, so a new
  // locally-built feed exempts itself and a new fetched-but-unproduced one
  // still fails. A hand-maintained exemption list is how the FEEDS list got
  // out of date in the first place.
  const LIVE = new Set(["stats"]);          // /stats.json is an API route
  const WF = readdirSync(".github/workflows")
    .filter((f) => f.endsWith(".yml") && f !== "sync-data.yml")
    .map((f) => readFileSync(join(".github/workflows", f), "utf8"))
    .join("\n");
  const builtHere = (f) => WF.includes(`public/${f}.json`);
  const fetched = new Set(
    [...JS.matchAll(/get\(\s*['"]\/([a-z0-9_-]+)\.json['"]/g)].map((m) => m[1])
  );
  const unmirrored = [...fetched].filter(
    (f) => !LIVE.has(f) && !feeds.has(f) && !builtHere(f));
  ok("every .json the app fetches is in sync-data.yml's FEEDS (else it freezes)",
     unmirrored.length === 0, unmirrored);

  // The reverse: a feed synced but read by nobody is dead weight in the repo
  // and a file that will quietly rot into a wrong answer if it is ever wired up.
  const OTHER = new Set(["edition", "screen"]);   // read by index.html / gems.js
  const orphan = [...feeds].filter(
    (f) => !fetched.has(f) && !OTHER.has(f) &&
           !JS.includes(`${f}.json`) && !GEMS.includes(`${f}.json`) &&
           !HTML.includes(`${f}.json`)
  );
  ok("no feed is mirrored that nothing reads", orphan.length === 0, orphan);
}

/* ── A LANE IS NOT A DATABASE KEY ────────────────────────────────────────────
 * The incident: the alert log rendered `esc(x.lane)`, so a row read
 * "HINDCOPPER  buoy · reclaim" and nothing on the page said what "reclaim"
 * meant. engine_names.py exists one level down for exactly this — alerts print
 * names, never keys — and the lane slipped through because it is a field on
 * the row rather than the row's engine.
 *
 * It is not cosmetic. The two lanes carry SEPARATE measured records and the
 * looser rule owns the larger sample (n=348 against n=35), so a reader shown
 * only the key cannot tell which evidence they are looking at. */
{
  const lanes = (JS.match(/const LANES = \{[\s\S]*?\n  \};/) || [""])[0];
  ok("a LANES registry exists, next to ENGINE_REGISTRY", lanes.length > 0);
  for (const k of ["strict", "reclaim"]) {
    ok(`LANES declares ${k}`, lanes.includes(`${k}:`));
  }
  // Every lane the scans write must be declared, read off the Python.
  ok("LANES has a name and a meaning for each lane",
     (lanes.match(/name:/g) || []).length === (lanes.match(/what:/g) || []).length);

  // No render site may interpolate the raw value.
  const raw = [...JS.matchAll(/esc\(\s*x\.lane\s*\)/g)].map((m) => lineOf(JS, m.index));
  ok("no template prints the raw lane key", raw.length === 0, raw);

  // The lane's sample must come from the payload, never be typed in the page.
  ok("a lane's record is read from the engine's backtest block",
     JS.includes("laneStat(") && /nKey:\s*['"]n_no_div['"]/.test(lanes));
}

/* ── ONE CARD MUST NOT PRINT TWO THINGS UNDER ONE NAME ───────────────────────
 * The incident: SARDAEN's card showed "Target 1 ₹594.82 / Target 2 ₹649.21"
 * from the signal, and the support-and-resistance table under it showed
 * "Target 2 ₹576.44 / Target 1 ₹557.96" from the SCREEN's ladder. Four numbers,
 * two labels, one screen. Neither was wrong; the table was answering a question
 * it was not being asked, and a reader had no way to tell which pair to act on.
 *
 * levelsBlock always receives a SCREEN row, so every level it names is the
 * screen's. It must say so rather than borrow the signal's vocabulary. */
{
  const blk = (JS.match(/const levelsBlock = \(r\) => \{[\s\S]*?\n  \};/) || [""])[0];
  ok("levelsBlock exists", blk.length > 0);
  // No bare "Target N" label inside the levels table.
  const bare = [...blk.matchAll(/add\([^,]+,\s*[`'"]Target \$?\{?/g)].map((m) => lineOf(blk, m.index));
  ok("the levels table does not label a screen level 'Target N'", bare.length === 0, bare);
  ok("its ladder levels are attributed to the screen",
     /The screen's target/.test(blk) && /The screen's stop/.test(blk));
  // Both must disown the signal's numbers in the same breath.
  ok("each says it is not the signal's own level",
     (blk.match(/not the (target this signal was filed with|stop the engine)/g) || []).length === 2);
}

/* ── AHIMSA IS THREE-STATE, AND MUST NEVER COLLAPSE TO TWO ───────────────────
 * NSE publishes the Nifty500 Ahimsa CONSTITUENT LIST and no per-company
 * quotient. So the page may report membership and must not report a figure.
 *
 * The dangerous shortcut is `r.ahimsa ? 'In' : 'Not in'`: the build sets the
 * key to null when NSE's list could not be read, _compact strips nulls, and a
 * falsy test then marks all 500 names as excluded on a failed fetch — an
 * ethics claim manufactured by a network error. */
{
  const strip = (JS.match(/const factsStrip = \(r, opts\) => \{[\s\S]*?\n  \};/) || [""])[0];
  ok("the facts strip reports Nifty500 Ahimsa", /Nifty500 Ahimsa/.test(strip));
  ok("membership is tested with ===, so null is its own state",
     /r\.ahimsa === true/.test(strip) && /r\.ahimsa === false/.test(strip));
  ok("a truthy shortcut is not used for it",
     !/r\.ahimsa\s*\?/.test(strip.replace(/r\.ahimsa == null \?/g, "")));
  ok("the unknown state says so rather than answering No",
     /not stated/.test(strip));
  // No score, ever: the index has no published per-company number.
  ok("no ahimsa score or quotient is rendered",
     !/ahimsa[_ ]?(score|quotient|pct|points)/i.test(JS));
}

/* ── A var() WITH NO DEFINITION IS A SILENTLY DELETED RULE ───────────────────
 * The incident: the radar and signals surfaces were written against --sans and
 * --dn. Neither token exists in this stylesheet — the names are --ui and
 * --down. A var() that resolves to nothing is invalid at computed-value time,
 * so the WHOLE declaration is discarded: no console error, no visual clue that
 * a rule was ever written.
 *
 *   .rd-f b.dn{color:var(--dn)}  ->  every negative number in the facts strip
 *                                    inherited body colour. "3 months -4.20%"
 *                                    and "off its high -18.5%" rendered black.
 *   font:600 var(--t-1)/1 var(--sans)  ->  the whole `font` SHORTHAND dropped,
 *                                    so those labels lost size and weight too.
 *
 * 27 declarations across six names, live, for as long as those surfaces have
 * existed. This is the cheapest possible check for the most invisible possible
 * failure. */
{
  const defined = new Set(
    [...CSS.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])
  );
  // Set at runtime rather than in the sheet: el.style.setProperty(...) in the
  // app, or an inline style="--w:..." on an element it renders.
  const runtime = new Set(
    [...JS.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)['"]/gi)].map((m) => m[1])
      .concat([...JS.matchAll(/(--[a-z0-9-]+)\s*:\s*\$\{/gi)].map((m) => m[1]))
  );
  const missing = [];
  for (const m of CSS.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
    const [, name, next] = m;
    if (next === ",") continue;            // has a fallback; degrades on purpose
    if (defined.has(name) || runtime.has(name)) continue;
    missing.push(`${name} (line ${lineOf(CSS, m.index)})`);
  }
  ok("every var() resolves — an undefined one deletes its whole declaration",
     missing.length === 0, missing);
}

/* ── THE LITE TABLE MUST STILL CARRY EVERYTHING THE PAGE READS ───────────────
 * screen-lite.json is screen.json with 29 unread fields and the per-company
 * prose removed: 298 KB gzipped down to 207 KB, on the nine routes that LIST
 * companies rather than examine one.
 *
 * Its keep-list lives in another repo (stock_screen.LITE_DROP_FIELDS) and the
 * code that consumes it lives here, which is exactly the shape of coupling
 * that rots. This check closes it from this side: every field signal.js reads
 * must be present in the payload it reads it from, or the page renders an
 * em dash and nobody hears about it. */
{
  const litePath = "public/screen-lite.json";
  let lite = null;
  try { lite = JSON.parse(readFileSync(litePath, "utf8")); } catch { /* not synced yet */ }
  /* The file is a build artefact that arrives via sync-data.yml, so on a fresh
   * branch it is legitimately absent and this must not block a deploy. What is
   * NOT optional is that it is on its way: if the feed list does not name it,
   * it will never arrive and the nine routes 404 on every load. So the
   * PIPELINE is asserted unconditionally and the CONTENT only when present. */
  const SYNC = readFileSync(".github/workflows/sync-data.yml", "utf8");
  ok("screen-lite is in the sync feed list, so it will arrive",
     /FEEDS="[^"]*\bscreen-lite\b/.test(SYNC));
  if (lite) {
    ok("screen-lite.json declares itself lite and carries rows",
       lite.is_lite === true && Array.isArray(lite.rows) && lite.rows.length > 0);
  } else {
    console.log("  note  screen-lite.json not synced into this checkout yet");
  }

  if (lite && lite.rows) {
    const have = new Set();
    for (const r of lite.rows.slice(0, 400)) for (const k of Object.keys(r)) have.add(k);
    // Fields legitimately absent: they are the prose and the columns only the
    // full-payload routes read, and the payload names them itself.
    const dropped = new Set(lite.lite_dropped || []);
    // The comparison is against screen.json ITSELF, not a list written here.
    // A field the current build has not shipped yet (ahimsa, added the day this
    // was written) is absent from both files and is not a projection bug; a
    // field present in the full table and missing from the lite one is.
    let full = null;
    try { full = JSON.parse(readFileSync("public/screen.json", "utf8")); } catch { /* */ }
    if (full && full.rows) {
      const inFull = new Set();
      for (const r of full.rows.slice(0, 400)) for (const k of Object.keys(r)) inFull.add(k);
      const missing = [];
      for (const m of JS.matchAll(/\br\.([a-z][a-z0-9_]{2,})\b/gi)) {
        const f = m[1];
        if (!inFull.has(f)) continue;          // not a screen column at all
        if (have.has(f) || dropped.has(f)) continue;
        missing.push(f);
      }
      ok("every screen column the page reads survives the lite projection",
         missing.length === 0, [...new Set(missing)]);
    }

    // The prose is the point of the saving; if it comes back the saving is gone.
    const withProse = lite.rows.filter(
      (r) => (r.risk && r.risk.flags) || (r.vd && r.vd.f)).length;
    ok("the per-company prose is NOT in the lite table", withProse === 0, withProse);
  }
}

/* ── A LITE CACHE MUST NEVER SERVE A ROUTE THAT NEEDS THE PROSE ──────────────
 * SCREEN is one module-level cache shared by every route. Without the variant
 * flag, the first light route to load poisons /screen and /stock/:id: both
 * open with `if (!SCREEN)`, find a full cache, and render a company page whose
 * risk flags are silently absent. Not an error — an empty section, on the page
 * whose entire job is to explain that company. */
{
  ok("the cache records which projection it holds", /let SCREEN_LITE = false/.test(JS));
  ok("SCREEN is only ever set through setScreen",
     !/\bSCREEN = \((?!.*setScreen)/.test(JS.replace(/let SCREEN = null;/, "")));
  // Comment lines explain this guard and would otherwise be counted as uses
  // of it — the same trap that made an earlier check match its own docstring.
  const code = JS.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  const fullGuards = (code.match(/!SCREEN \|\| SCREEN_LITE/g) || []).length;
  ok("all three full-payload call sites reject a lite cache", fullGuards === 3, fullGuards);
  // And nothing may reach for the raw path any more.
  ok("no route fetches '/screen.json' by literal — FULL_URL or LITE_URL",
     !/get\(\s*['"]\/screen\.json['"]\s*\)/.test(JS));
  /* The light routes go through getScreen(false), which asks for the lite
     table and FALLS BACK to the full one when it 404s. That fallback is not
     optional: screen-lite.json is produced by one pipeline and delivered by
     another, so there is a window where this code is live and the file is not
     — and on the deploy that shipped this, /radar fetched a 404 and rendered
     ZERO names. A missing projection is not a missing answer. */
  ok("the lite fetch falls back to the full table rather than failing",
     /const getScreen = async \(wantFull\) => \{[\s\S]*?return \{ r: await get\(FULL_URL\), lite: false \};/.test(JS));
  const liteN = (JS.match(/getScreen\(false\)/g) || []).length;
  ok("every light route goes through it", liteN >= 7, liteN);
  ok("no light route sets the lite flag as a literal true",
     !/setScreen\([^;]*\), true\)/.test(JS));
}

/* ── SIX SLOTS, SIX ANSWERS ──────────────────────────────────────────────────
 * The bar was Home / Signals / Discover / Watch / More. Two faults:
 *   - /markets — the one route that answers "what is happening?" — was
 *     reachable from NO tab. It existed and was navigable only by search or a
 *     link on Home.
 *   - "More" is not a destination. In a five-slot bar one slot said nothing,
 *     and everything in it a phone needs day to day (search, freshness, theme,
 *     density) was already in the header.
 * Every tab must be a real, renderable route — a bar entry pointing at a
 * missing route is a dead end the router turns into a 404.
 *
 * ── AND THE SIXTH SLOT IS /brief, FOR THE SAME REASON /markets IS HERE ──────
 * It was the third instance of the fault this block was written for: the
 * longest page on the site, reachable from a phone only through the header
 * CTA — which signal.css hides under 560px — or a "Full brief" link inside an
 * expanded ledger card. Both of those are links from somewhere else, and a
 * destination with no entry of its own is not navigable.
 *
 * The count is asserted EXACTLY, not as a floor. A bar that can grow silently
 * is how the seventh tab once pushed a 390px phone to 454px and scrolled the
 * whole page sideways; the layout absorbs a deliberate change and must not
 * absorb an accidental one. Adding a tab means editing this number and saying
 * why, here. */
{
  const nav = [...HTML.matchAll(/<a href="(\/[a-z/]*)" data-route="([^"]+)">[\s\S]*?<span>([^<]+)<\/span>/g)]
    .map((m) => ({ href: m[1], route: m[2], label: m[3] }));
  ok("the bar has six slots", nav.length === 6, nav.map((n) => n.label));
  ok("href and data-route agree on every tab",
     nav.every((n) => n.href === n.route), nav.filter((n) => n.href !== n.route));

  const routes = new Set([...JS.matchAll(/R\['(\/[a-z0-9:/-]*)'\]\s*=/g)].map((m) => m[1]));
  const dead = nav.filter((n) => !routes.has(n.route));
  ok("every tab points at a route the app can render", dead.length === 0, dead);

  ok("Markets is in the bar — it answers the first question the app exists for",
     nav.some((n) => n.route === "/markets"));
  ok("Brief is in the bar — on a phone it had no entry of its own at all",
     nav.some((n) => n.route === "/brief"), nav.map((n) => n.route));
  ok("no slot is a junk drawer",
     !nav.some((n) => /^(more|other|misc)$/i.test(n.label.trim())),
     nav.map((n) => n.label));

  // What "More" held that lives nowhere else must still be reachable.
  ok("the provenance links moved to the Ledger rather than being dropped",
     /const provenance = \(\) => sec\(/.test(JS) && /provenance\(\);/.test(JS));
  ok("nothing still binds the removed #moreBtn", !/getElementById\('moreBtn'\)/.test(JS));
}

/* ── EVERY EXPLANATION MUST BE REACHABLE, AND THE BIG NUMBERS MUST HAVE ONE ──
 * TIPS carried nine entries and covered the mechanics — the 52-week range, the
 * session, R:R — while none of the four figures a reader actually decides on
 * had a help mark. A "?" on `zone` and none on `win rate` explains the easy
 * number and leaves the load-bearing one bare.
 *
 * `basis` was also defined and surfaced NOWHERE: an explanation written, paid
 * for in bytes, and never once shown. */
{
  const block = (JS.match(/const TIPS = \{[\s\S]*?\n  \};/) || [""])[0];
  const keys = [...block.matchAll(/^\s{4}(\w+):\s*\[/gm)].map((m) => m[1]);
  ok("TIPS is readable", keys.length > 0);

  // Two ways to surface one: tip('k') inline, or tile(..., 'k') on a label.
  const used = new Set([
    ...[...JS.matchAll(/\btip\('(\w+)'\)/g)].map((m) => m[1]),
    ...[...JS.matchAll(/,\s*'(\w+)'\)\}/g)].map((m) => m[1]),
  ]);
  const orphan = keys.filter((k) => !used.has(k));
  ok("every TIPS entry is surfaced somewhere", orphan.length === 0, orphan);

  for (const k of ["winrate", "score", "call", "risk"]) {
    ok(`the ${k} figure carries an explanation`, keys.includes(k) && used.has(k));
  }

  // The control goes on the LABEL, never on the value: answer first, reason
  // second. tile() takes the key as its fifth argument and renders it inside
  // the .k element, so this holds by construction — assert the construction.
  ok("tile() renders its tip on the label, not the value",
     /<div class="k">\$\{esc\(k\)\}\$\{tipKey \? ' ' \+ tip\(tipKey\) : ''\}<\/div>/.test(JS));
}

/* ── ONE FIELD, ONE VOCABULARY ───────────────────────────────────────────────
 * `vd.c` was rendered two ways depending on the page: the screen said Act and
 * Ignore where the radar said Buy and Avoid. Same company, same build, same
 * field, two answers — and "Act" is a stronger word than a site with no
 * cleared engine is entitled to use.
 *
 * It survived because test/ui.mjs pins the vocabulary by sampling `.rd-v` on
 * the radar, and nothing looked at the screen's tag. The map is single now;
 * this asserts it stays single. */
{
  ok("there is exactly one verdict table", /const VERDICT = \{/.test(JS));
  ok("VD_WORD is derived from it, not hand-kept",
     /const VD_WORD = Object\.fromEntries\(/.test(JS));
  ok("VERDICT_LOOK is derived from it, not hand-kept",
     /const VERDICT_LOOK = VERDICT;/.test(JS));
  /* THE REAL INVARIANT, not a list of banned words.
   *
   * Banning "Act" catches the spelling that happened; it does not catch the
   * next one. What must hold is that the words this table produces are the
   * words test/ui.mjs allows on the live page — so the two files are compared
   * against each other rather than both against a guess. That is the check
   * that would have caught the original drift on the day it landed. */
  const vblock = (JS.match(/const VERDICT = \{[\s\S]*?\n  \};/) || [""])[0];
  const words = [...vblock.matchAll(/\[\s*'[a-z]*',\s*'([^']+)'\s*\]/g)].map((m) => m[1]);
  const UI = readFileSync("test/ui.mjs", "utf8");
  const allowed = [...(UI.match(/const allowed = new Set\(\[([^\]]*)\]/) || ["", ""])[1]
    .matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  ok("ui.mjs declares an allowed verdict set", allowed.length > 0);
  const stray = words.filter((w) => !allowed.includes(w));
  ok("every word the verdict table produces is one the live page allows",
     stray.length === 0, stray);
  ok("the two files agree on the whole set",
     words.length === allowed.length, { words, allowed });
  // UNRATED must be declared, not reached by falling off the end of the table.
  ok("UNRATED is a declared verdict, not an accident of the default",
     /UNRATED:\s*\[/.test(JS));
}

/* ── A TARGET THAT DOES NOT EXIST IS NEVER THE PREVIOUS ONE AGAIN ────────────
 *
 * The incident: the brief read
 *
 *     const t2 = N(sig.target2 || sig.target1);
 *
 * The API blanks a target that sits inside 0.5R of the one before it —
 * _levels.js, and the generator now refuses to produce them at all — and
 * returns null. The `||` put T1's price back under T2's label and every
 * consumer downstream believed it: the ladder printed "Target 2" and
 * "Target 1" at one price, the chart drew two lines on top of each other, the
 * glance bar drew a zero-width second reward segment, and the Risk section
 * said "1.6 to one against the first target and 1.6 to one against the
 * second". SPLPETRO shipped exactly that, on a row whose own ledger card read
 * "the only target".
 *
 * The same shape has now been fixed three times in this file — trailPlan
 * (Number(t2) making a null into a ₹0.00 exit), price() (the same coercion),
 * and the brief. So the rule bans the SHAPE, not the instance. */
{
  /* Comment lines are excluded, or this rule fails on the note above the fix
   * that quotes the very line it bans — a check that cannot survive its own
   * incident being written down is a check nobody will keep. */
  const CODE = JS.split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  const fallback = /target[23]\s*\|\|\s*(sig\.)?target[123]/;
  ok("no level falls back to the level before it",
     !fallback.test(CODE),
     (CODE.match(/.{0,60}target[23]\s*\|\|\s*(sig\.)?target[123].{0,40}/) || [])[0]);
  ok("the brief decides on one flag, and every consumer reads it",
     /const hasT2 = t2 !== null;/.test(JS));
  ok("the brief's second target comes through lvl(), which treats 0 as absent",
     /const t2 = lvl\(sig\.target2\);/.test(JS));
  /* A scale or a zone still needs the top of the trade on a one-target row.
   * tFinal is that, and it is a DIFFERENT name from t2 on purpose — the fault
   * above was one variable meaning two things. */
  ok("a one-target setup still draws to scale rather than drawing nothing",
     /const tFinal = hasT2 \? t2 : t1;/.test(JS));
  const rr2 = (JS.match(/const rrT2 = [^;]+;/) || [""])[0];
  ok("reward-to-risk against a target that is not published is null, not a repeat of T1",
     /hasT2 \?/.test(rr2) && /: null/.test(rr2), rr2);
}

/* ── THE BRIEF ARGUES A COMPANY, NOT ONLY A CHART ────────────────────────────
 *
 * The incident: the brief's five score components were Structure, Momentum,
 * Trend, Volume and Risk-reward — every one of them a price measurement. The
 * screen row this route already downloads carries return on capital, leverage,
 * cash conversion, growth, valuation and the screen's own risk flags, and none
 * of it reached the page. A reader got to the trade plan having been told the
 * chart was willing and nothing whatsoever about the business.
 *
 * ── AND THE SECTION IS NOT WRITTEN HERE ──────────────────────────────────
 *
 * It is rendered by public/brief_fundamentals.js, one file shared with the
 * newspaper's brief and authored upstream beside stock_screen.py, which
 * computes every field in it. So what is pinned on THIS side is the WIRING —
 * that the section exists, that it calls the shared renderer, and that a file
 * which did not arrive produces a notice rather than a hole. What the renderer
 * puts in it is pinned in that file's own repo.
 *
 * The three rules below are the ones a future edit here could break without
 * touching the renderer at all. */
{
  ok("the brief has a business section", /'b-fund', 'Business'/.test(JS));
  ok("it is in document order too, not just in the nav", /id="b-fund"/.test(JS));

  const fund = (JS.match(/id="b-fund"[\s\S]*?<\/section>/) || [""])[0];
  ok("the section calls the shared renderer rather than carrying its own copy",
     /window\.BriefFundamentals\s*\n?\s*\?\s*window\.BriefFundamentals\.render\(row,/.test(fund),
     fund.slice(0, 160));
  /* A 404 on a file that crosses a repo boundary is a state, not an
   * impossibility. A section that vanishes silently is indistinguishable from
   * one that was never meant to be there. */
  ok("a renderer that did not arrive produces a notice, not a hole",
     /could not load/.test(fund));
  /* The two sites route their screens differently — /screen?q= here, a hash
   * route there. A link that renders the front page looks like a click that
   * was ignored, so each caller supplies its own. */
  ok("the caller supplies its own screen link", /screenHref:/.test(fund));

  /* THE FILE HAS TO BE SERVED, AND ITS STYLES TRAVEL INSIDE IT.
   * A companion stylesheet would be a second thing to sync and the markup
   * could reach a page whose CSS did not. */
  const files = new Set(readdirSync("public"));
  ok("the shared renderer is in public/", files.has("brief_fundamentals.js"));
  const BF = readFileSync("public/brief_fundamentals.js", "utf8");
  ok("it defines what the page calls", /root\.BriefFundamentals = \{/.test(BF));
  ok("it carries its own styles", /var CSS = \[/.test(BF) && /getElementById\(STYLE_ID\)/.test(BF));
  ok("the shell loads it before the renderer",
     HTML.indexOf('src="/brief_fundamentals.js"') > -1 &&
     HTML.indexOf('src="/brief_fundamentals.js"') < HTML.indexOf('src="/signal.js"'));
  /* signal.css must NOT re-declare what the shared file carries, or the two
   * drift and the page shows whichever loses the cascade. */
  ok("signal.css does not keep a second copy of those styles",
     !/\.bf-(tbl|pctl|flags|riskg|bar)\b/.test(CSS));

  /* And the sync has to actually collect it — it is not authored here, so if
   * nothing fetches it this repo silently keeps whatever was committed by
   * hand, which is the exact fault that froze #research for a week. */
  const SYNC = readFileSync(".github/workflows/sync-data.yml", "utf8");
  ok("sync-data.yml fetches the shared renderer",
     /brief_fundamentals\.js/.test(SYNC));
  ok("and validates it as JavaScript, not just as a non-empty file",
     /node --check/.test(SYNC) && /grep -q 'BriefFundamentals'/.test(SYNC));
}

/* ── EVERY SECTION THE CHIPS ADVERTISE MUST HAVE A KEY THAT REACHES IT ───────
 * The chips print their keyboard shortcut. A section added to SECTIONS without
 * a matching digit gets a chip advertising a key that does nothing. */
{
  const secs = (JS.match(/const SECTIONS = \[[\s\S]*?\n    \];/) || [""])[0];
  const nSec = (secs.match(/\['b-/g) || []).length;
  const digits = (JS.match(/const i = '(\d+)'\.indexOf\(ev\.key\);/) || ["", ""])[1];
  ok("the brief declares its sections", nSec > 0, nSec);
  ok("every section has a digit that jumps to it",
     nSec === digits.length, { sections: nSec, digits });
}

console.log(fails
  ? `\n${fails} of ${checks} guard checks FAILED`
  : `\n${checks}/${checks} guard checks pass`);
process.exit(fails ? 1 : 0);
