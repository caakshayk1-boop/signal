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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { WATCH, dueSlot, GRACE_MIN } from "../src/watchdog_schedule.js";

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
      /* A FALSY CHECK IS A GUARD, and a stronger one than the idioms above.
       * This flagged gridVal(), which opens:
       *     const raw = (cell ? cell.textContent : '').trim();
       *     if (!raw || raw === '—' || ...) return null;
       * `!raw` rejects null, undefined AND '' — every case this rule exists to
       * catch, and more than `=== ''` catches on its own. The rule was right
       * about the shape and wrong about the idiom, so it failed on correct
       * code, which is how a rule teaches people to skip it.
       *
       * The falsy check only counts when it SHORT-CIRCUITS BEFORE the
       * coercion. `if (!x) doSomething()` that falls through to Number(x)
       * guards nothing, and this still fails on it. */
      const explicit = /(==|===)\s*null|!=\s*null|!==\s*null|===\s*undefined|undefined\s*===|===\s*''|typeof\s+\w+\s*===/.test(body);
      const firstCoerce = body.search(/Number\s*\(/);
      const beforeCoerce = firstCoerce < 0 ? body : body.slice(0, firstCoerce);
      const falsyExit = /if\s*\(\s*!\w[\s\S]{0,120}?\)\s*(\{[^{}]{0,80}?)?\breturn\b/.test(beforeCoerce);
      if (!explicit && !falsyExit) bad.push(`${file}:${lineOf(code, m.index)}`);
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

/* ── THE CHROME MUST NOT DOWNLOAD THE LARGEST FILE ON THE SITE ───────────────
 *
 * paintFreshness() runs ONCE, at boot, on the line before render() — so its
 * requests start before any route body has run. Its FEED_AGE table named
 * '/screen.json': 1.98 MB raw, 253 KB brotli, the biggest asset here, fetched
 * on every cold load of every route to read one timestamp off the top of it.
 * The seven light routes fetch screen-lite.json specifically to avoid that
 * file, and the bar above them was buying it anyway.
 *
 * It also filled sessionStorage. Measured on /radar — screen + lite +
 * institutional — the ~5 MB origin quota was exhausted, so the stale-copy
 * write for whatever loaded next threw and was swallowed.
 *
 * The row is PASSIVE now: the bar never fetches a screen, and get() hands it
 * the stamp off whichever projection the route loaded for its own reasons.
 * Three things have to hold for that to be honest, and each is checked. */
{
  const code = JS.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

  // 1. The bar must not name a screen payload as a row it fetches.
  const feedAge = (code.match(/const FEED_AGE = \[[\s\S]*?\n  \];/) || [""])[0];
  ok("the freshness bar has a FEED_AGE table to check", feedAge.length > 0);
  ok("no FEED_AGE row names a screen payload — the bar must not fetch 1.98 MB",
     !/screen(-lite)?\.json/.test(feedAge), feedAge.match(/screen[^'"]*\.json/g));

  // 2. Its resolver must be able to answer NOTHING. Returning a URL when the
  //    payload is not already paid for is how this regressed once mid-fix:
  //    on a cold /screen the bar fetched lite and the route then fetched
  //    full, 435 KB in total to avoid 253 KB.
  /* The body is captured to the first line that closes it at this nesting,
     NOT with a lazy [\s\S]*? run at the whole file: the first version did
     that, found a `return null;` some thousands of lines later, and passed
     against a resolver that had been put back to fetching the lite table. A
     check that cannot fail is worse than no check. */
  const resolver = (code.match(/const screenAgeUrl = \(\) => \{[\s\S]*?\n  \};/) || [""])[0];
  ok("the screen's age resolver is present and self-contained",
     resolver.length > 0 && resolver.length < 400, resolver.length);
  ok("the screen's age row fetches nothing of its own",
     /return null;/.test(resolver) && !/return (LITE_URL|FULL_URL|'\/screen)/.test(
       resolver.replace(/if \([^\n]*\) return u;/, "")), resolver);

  // 3. A passive row has to be FILLABLE, or the screen silently never reports
  //    its age. The fill is hooked into get() — the one place that sees every
  //    fetch — and an earlier version hung it off noteScreenMeta(), which four
  //    of the nine screen-loading routes do not call.
  ok("the passive row is filled from get(), not from a route",
     /if \(PASSIVE_AGE_ROWS\[base\]\) noteFeedAge\(/.test(code));
  const passive = (code.match(/const PASSIVE_AGE_ROWS = \{[\s\S]*?\};/) || [""])[0];
  for (const u of ["/screen.json", "/screen-lite.json"]) {
    ok(`both projections fill the same row — ${u}`,
       new RegExp(`'${u}': 'Stock screen'`).test(passive));
  }
  ok("the label a passive row fills is a label FEED_AGE actually has",
     /\['Stock screen',/.test(feedAge));

  // 4. And the two projections must genuinely carry the same stamp, or the
  //    bar reports a different age depending on which route the reader
  //    landed on. stock_screen.lite_payload() copies every top-level key but
  //    `rows`; this asserts the result rather than trusting the promise.
  {
    let full = null, lite = null;
    try { full = JSON.parse(readFileSync("public/screen.json", "utf8")); } catch { /* not synced */ }
    try { lite = JSON.parse(readFileSync("public/screen-lite.json", "utf8")); } catch { /* not synced */ }
    if (full && lite) {
      const stamps = ["generated_at", "built_at", "built_on", "price_date"];
      const differ = stamps.filter((k) => JSON.stringify(full[k]) !== JSON.stringify(lite[k]));
      ok("both screen projections carry the same build stamp", differ.length === 0, differ);
    } else {
      console.log("  note  screen payloads not both synced into this checkout yet");
    }
  }

  // 5. The stale-copy write must not block the load. It is a fallback for a
  //    LATER failed fetch; nothing on this load reads it, and a 1.26 MB
  //    sessionStorage write is synchronous.
  ok("the sessionStorage stash is deferred, not written during the fetch",
     /requestIdleCallback\(stash/.test(code) && /else setTimeout\(stash, 0\)/.test(code));
  // 6. And it reuses the serialisation that was already made, rather than
  //    running JSON.stringify over the same megabyte twice.
  ok("the payload is serialised once per fetch",
     (code.match(/JSON\.stringify\(\{ at: Date\.now\(\), j \}\)/g) || []).length === 0);
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
  /* FOUR, not three. A fourth full-payload route was added and this constant
   * was not moved with it, so the check has been red since — reporting a
   * CORRECTLY guarded call site as a failure.
   *
   * It stays an EXACT count rather than becoming `>= 3`, because the exact
   * form is what catches the dangerous direction: a guard deleted from an
   * existing site. `>=` would pass while a route quietly started reading a
   * lite cache. The four are the screen, the company page, the engine floor
   * and the regime panel; adding a fifth means moving this number, on
   * purpose, in the same commit. */
  const fullGuards = (code.match(/!SCREEN \|\| SCREEN_LITE/g) || []).length;
  ok("every full-payload call site rejects a lite cache", fullGuards === 4, fullGuards);
  /* And nothing may reach for the raw path any more — through get(), and
   * equally through the two CACHE lookups.
   *
   * The front page read CACHED('/screen.json') while its own retry fetched
   * the LITE projection: two URLs, so the lookup could never be answered by
   * the route's own request. It worked only because the freshness bar in the
   * header was downloading screen.json at boot for an unrelated reason, and
   * when that stopped, the volume-spurts count went from 20 to 0. A literal
   * is how a caller ends up asking for a file nobody on that route fetches. */
  const litSel = /(?:get|CACHED|HELD)\(\s*['"]\/screen(?:-lite)?\.json['"]\s*\)/g;
  const lits = code.match(litSel) || [];
  ok("no route reaches a screen payload by literal — FULL_URL or LITE_URL",
     lits.length === 0, lits);
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

/* ── CI MUST DEPLOY THE SAME WAY A LAPTOP DOES ──────────────────────────────
 * `wrangler deploy` on its own ships whatever public/*.json is COMMITTED, and
 * those are only as fresh as the last sync that committed them. So any push —
 * a CSS tweak, a comment — republished stale feeds and rolled the live site
 * back. It happened twice in one evening: 989 rows and 325 Ahimsa constituents
 * verified live, then back to 748 and 0, because a later push redeployed an
 * older commit of the same file. `npm run deploy` pulls the feeds first. */
{
  const DEP = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  ok("CI deploys with npm run deploy, which refreshes the feeds first",
     /run: npm run deploy/.test(DEP));
  ok("CI does not deploy the committed feeds with a bare wrangler deploy",
     !/run: npx wrangler deploy\s*$/m.test(DEP));
}

/* ── EVERY FEED THE FRONTEND FETCHES MUST BE SYNCED ─────────────────────────
 * screen-lite.json is read by nine light routes and was absent from FEEDS, so
 * it froze at whatever commit last carried it: screen.json served 989 rows and
 * 325 Ahimsa constituents while screen-lite.json, same origin, served 748 and
 * zero. A feed the site fetches and the sync does not pull is stale by
 * construction, and it looks like working data. */
{
  const PULL = readFileSync("scripts/pull-feeds.mjs", "utf8");
  /* FETCH SITES, not every string that looks like a path. This matched any
   * '/x.json' literal anywhere in the bundle and so flagged `buoy`, whose
   * only appearance is in the FEED LABEL map — the table that turns a feed
   * path into the words "BUOY research" on the freshness bar. Nothing fetches
   * it; pull-feeds.mjs says so in a comment and deliberately does not mirror
   * it. The rule was reporting a feed as un-synced because the site knows how
   * to NAME it.
   *
   * Reading only get()/CACHED()/fetch() keeps the rule pointed at what it is
   * about: a feed the site actually READS and the sync does not pull is stale
   * by construction and looks like working data. */
  const fetched = [...JS.matchAll(/\b(?:get|CACHED|fetch)\s*\(\s*['"]\/([a-z-]+)\.json['"]/g)]
    .map(m => m[1]);
  /* Two exceptions, both produced HERE rather than synced: build.json is
     stamped at deploy time by scripts/stamp-build.mjs, and institutional.json
     is built by this repo's own institutional.yml from exchange filings. */
  const LOCAL = new Set(["build", "institutional"]);
  const missing = [...new Set(fetched)]
    .filter(f => !LOCAL.has(f) && !PULL.includes(`"${f}"`));
  ok("every /*.json the frontend fetches is in the feed sync list",
     missing.length === 0, missing);

  /* TWO LISTS FOR ONE JOB. pull-feeds.mjs runs on deploy, sync-data.yml runs
     on a schedule, and they had drifted in BOTH directions — engines and funds
     in one, buoy and swot in the other. Whichever ran last decided what the
     site served, which is how screen-lite.json sat at 748 rows and zero Ahimsa
     constituents while screen.json beside it served 989 and 325. */
  const SYNC_YML = readFileSync(new URL("../.github/workflows/sync-data.yml", import.meta.url), "utf8");
  const syncList = ((SYNC_YML.match(/FEEDS="([^"]+)"/) || [])[1] || "").split(/\s+/).filter(Boolean).sort();
  const pullList = [...PULL.matchAll(/"([a-z][a-z_-]*)"/g)].map(m => m[1])
    .filter(f => syncList.includes(f) || /^(buoy|swot|screen-lite|engines|funds)$/.test(f));
  const onlySync = syncList.filter(f => !PULL.includes(`"${f}"`));
  ok("the deploy and the scheduled sync pull the same feeds", onlySync.length === 0, onlySync);
}

/* ── EVERY PUBLISHED PARTITION MUST ADD UP ───────────────────────────────────
 *
 * An external audit read the front page and did the arithmetic this build did
 * not: "160 of 985 screened names advanced and 818 declined" — 160 + 818 is
 * 978, and the seven missing names were never labelled. They are the unchanged
 * ones, and on a site whose argument is that it publishes its own losses, an
 * unexplained gap in a count reads as filtering rather than as an omission.
 *
 * The labels are fixed. This stops the class: any feed that publishes a
 * partition of a total has to reconcile, at BUILD time, before the number can
 * reach a reader. Checked against the committed feeds, so a bad sync fails the
 * deploy rather than shipping.
 *
 * It does NOT require up + down === counted. Unchanged names are real and the
 * whole point is that they be accounted for, not assumed away — so the rule is
 * that the parts must never EXCEED the whole, and that any remainder is
 * nameable. A partition summing past its total is arithmetic that cannot be
 * explained by a third bucket and is always a defect. */
{
  const partitions = [
    ["pulse.json", "breadth", (d) => d.breadth],
  ];
  for (const [file, label, pick] of partitions) {
    let feed = null;
    try { feed = JSON.parse(readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")); }
    catch { /* a feed that is not committed cannot be checked and is not a failure here */ }
    const b = feed && pick(feed);
    if (!b || !Number.isFinite(Number(b.counted))) continue;
    const up = Number(b.up) || 0, down = Number(b.down) || 0, total = Number(b.counted);
    ok(`${file} · ${label} — the parts never exceed the whole`,
       up + down <= total, `${up} up + ${down} down > ${total} counted`);
    ok(`${file} · ${label} — the remainder is a whole number of names`,
       Number.isInteger(total - up - down), total - up - down);
  }
}

/* ── THE CSP'S SCRIPT HASHES MUST MATCH THE SCRIPTS ──────────────────────────
 *
 * src/csp-hashes.js is generated from the inline <script> blocks in the
 * shells. A hash is a copy, and copies drift — except this one fails LOUD: an
 * inline script edited without regenerating produces a policy that blocks the
 * site's own theme bootstrap, which is a white page in production caused by a
 * security control. That is the worst kind of outage, because the code looks
 * right and the header looks right and only the pair is wrong.
 *
 * Imported from the same module the generator exports, so this checks the real
 * extraction rule rather than a second implementation of it. */
{
  const { inlineHashes } = await import("../scripts/csp-hashes.mjs");
  const generated = JSON.parse(
    readFileSync(new URL("../src/csp-hashes.js", import.meta.url), "utf8")
      .match(/INLINE_SCRIPT_HASHES = (\[[\s\S]*?\]);/)[1]);
  const current = inlineHashes();
  ok("the CSP's script hashes match the inline scripts",
     JSON.stringify(generated) === JSON.stringify(current),
     `run \`node scripts/csp-hashes.mjs\` — committed ${generated.length}, found ${current.length}`);
  ok("every inline script is hashed, none left to 'unsafe-inline'",
     current.length > 0 && !readFileSync(new URL("../src/index.js", import.meta.url), "utf8")
       .includes("script-src 'self' 'unsafe-inline'"));
}

/* ── NO FONT MAY BE SHIPPED, OR PRELOADED, WITHOUT A RULE THAT RENDERS IT ────
 * Manrope carried the interface until Plus Jakarta Sans replaced it. After
 * that --disp, --ui and --serif all pointed at Jakarta and NOTHING referenced
 * Manrope — yet four faces stayed in the repo, four @font-face blocks stayed
 * in the stylesheet, and index.html went on PRELOADING one of them.
 *
 * A preload is the highest-priority fetch a page can make. Spending one on a
 * font with no rule to render costs every visitor 24 KB on the critical path,
 * 100% of the time, for nothing. Dead weight is cheap to carry and expensive
 * to preload — which is why this checks both.
 *
 * "Referenced" means outside comments and outside @font-face itself: a family
 * that appears only in its own declaration is declaring itself, not being used. */
{
  const live = CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@font-face\{[\s\S]*?\}/g, "");
  const declared = [...new Set(
    [...CSS.matchAll(/@font-face\{font-family:'([^']+)'/g)].map((m) => m[1])
  )];
  ok("the stylesheet declares at least one face", declared.length > 0);

  const unused = declared.filter((f) => !new RegExp(`[^-]\\b${f}\\b`).test(live));
  ok("every declared @font-face family is referenced by a live rule",
     unused.length === 0, unused);

  // And every preloaded file must belong to a family that survived that check.
  const preloaded = [...HTML.matchAll(/rel="preload"[^>]*href="\/fonts\/([^"]+)"/g)]
    .map((m) => m[1]);
  const declaredSrc = [...CSS.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
  const orphanPreload = preloaded.filter((f) => !declaredSrc.includes(f));
  ok("every preloaded font file is one the stylesheet actually declares",
     orphanPreload.length === 0, orphanPreload);

  /* ── AND THE DIRECTORY MUST MATCH THE DECLARATIONS, BOTH WAYS ────────────
   *
   * The family check above passes for a family that is used at ONE weight and
   * shipped at three. Newsreader was exactly that: declared at 400, 600 and
   * 400-italic, and every rule that reaches it is written `font: 400 ...`, so
   * the bold and the italic could not be selected by anything in this
   * stylesheet. Measured in a browser at 414px and 1280px — 24 elements
   * rendering Newsreader on /brief, zero of them bold, zero italic — and the
   * two files were never fetched on any route. 48 KB in the repo and in every
   * deployment, reachable by nothing.
   *
   * Both directions are faults, and they are different faults:
   *   · a FILE with no declaration is dead weight in the deploy;
   *   · a DECLARATION with no file is a 404 the browser answers by silently
   *     falling back to Georgia, which looks like a design choice.
   *
   * Lazy loading is why neither shows up as a slow page — a face nothing
   * renders is never fetched — so nothing but this will ever notice. */
  const onDisk = readdirSync("public/fonts").filter((f) => /\.woff2?$/.test(f)).sort();
  const wanted = [...new Set(declaredSrc)].sort();
  ok("every font file in the repo is declared by the stylesheet",
     onDisk.every((f) => wanted.includes(f)), onDisk.filter((f) => !wanted.includes(f)));
  ok("every declared font file exists — a missing one falls back silently",
     wanted.every((f) => onDisk.includes(f)), wanted.filter((f) => !onDisk.includes(f)));

  /* ── AND THE OFFLINE SHELL MUST CARRY THE FACES EVERY ROUTE RENDERS ──────
   * sw.js precached seven faces the site had stopped using; the fix that
   * replaced them with the one variable face stopped there, and the site
   * loads THREE on every route. Measured across six routes: Jakarta plus
   * both JetBrains Mono weights on all six. Every price, ticker and table
   * figure here is --mono, so the offline shell rendered the prose correctly
   * and every NUMBER in a system monospace.
   *
   * Newsreader is excluded on purpose — 23 KB for one route's headings. So
   * this is not "every declared face"; it is every face the CHROME needs. */
  const SW = readFileSync("public/sw.js", "utf8");
  const SHELL_FONTS = ["PlusJakarta-var-latin.woff2",
                       "JetBrainsMono-400-latin.woff2",
                       "JetBrainsMono-500-latin.woff2"];
  for (const f of SHELL_FONTS) {
    ok(`the offline shell precaches ${f}`, SW.includes("/fonts/" + f));
  }
  /* A precache list that names a file the repo does not have fails silently:
     c.add() is caught per entry so the install still succeeds. */
  const swFonts = [...SW.matchAll(/"\/fonts\/([^"]+)"/g)].map((m) => m[1]);
  ok("the offline shell names no font the repo does not ship",
     swFonts.every((f) => onDisk.includes(f)), swFonts.filter((f) => !onDisk.includes(f)));
  /* CHANGING THE LIST WITHOUT BUMPING THE NAME SHIPS NOTHING. activate deletes
     every cache whose key is not CACHE, so a new SHELL under an old key is
     served from the old cache until something else evicts it. */
  ok("the cache key is versioned, so a changed shell actually replaces one",
     /const CACHE = "signal-shell-v(\d+)"/.test(SW) &&
     Number(SW.match(/signal-shell-v(\d+)/)[1]) >= 3,
     (SW.match(/signal-shell-v\d+/) || [])[0]);
}

/* ── THE COMMITTED ASSETS MUST STILL BE THE SOURCE ──────────────────────────
 * scripts/minify.mjs rewrites public/signal.js and public/signal.css IN PLACE
 * before wrangler deploy, because wrangler serves ./public directly. It
 * restores them in a finally — including when the deploy fails, which is the
 * case a `&&` chain gets wrong.
 *
 * If a restore is ever missed, the next `git add -A` commits a minified file,
 * and from then on the repository's documentation is gone and every later diff
 * is unreadable. That is not a small loss here: several of these comments are
 * the only record of why a rule exists.
 *
 * So this asserts the committed file is the AUTHORED one. It is also the
 * reason minify runs after guard in the deploy chain rather than before.
 *
 * It doubles as the check that the stripping is worth doing at all: if the
 * comment share ever fell near zero, the build step would be cost without
 * benefit and should be removed rather than carried. */
{
  const commentShare = (src) => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return 1 - stripped.length / src.length;
  };
  ok("public/signal.js is the authored source, not a minified artefact",
     commentShare(JS) > 0.10 && /\n\s*\/\*/.test(JS),
     `comment share ${(commentShare(JS) * 100).toFixed(0)}%`);
  ok("public/signal.css is the authored source, not a minified artefact",
     commentShare(CSS) > 0.10 && /\n\s*\/\*/.test(CSS),
     `comment share ${(commentShare(CSS) * 100).toFixed(0)}%`);

  // The build step must actually be in the chain that ships.
  const PKG = JSON.parse(readFileSync("package.json", "utf8"));
  ok("the deploy script minifies before it deploys",
     /minify\.mjs\s+--\s+.*wrangler deploy/.test(PKG.scripts.deploy || ""),
     PKG.scripts.deploy);
  ok("...and minifies AFTER the guard, which reads the authored source",
     (PKG.scripts.deploy || "").indexOf("guard.mjs")
       < (PKG.scripts.deploy || "").indexOf("minify.mjs"));
  ok("esbuild is a declared dependency, not something the deploy hopes is there",
     !!(PKG.devDependencies || {}).esbuild);
}

/* ── A BREACHED STOP VOIDS THE SETUP, ON EVERY SURFACE THAT SHOWS ONE ───────
 *
 * The rule shipped as four characters of comparison inside wireRadar's live
 * overlay, so it was true on /radar and nowhere else. The front page's
 * conviction slate is the worse case: it awaits live quotes and prints
 * "Live ₹940" four lines above "Stop ₹999.05", with the score and the
 * reward-to-risk between them, and said nothing. Five cards, first screen.
 *
 * Consistency between two surfaces cannot come from writing the same test in
 * both — it has to come from calling the same function. */
{
  const code = JS.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  ok("the void rule is declared exactly once",
     (code.match(/const stopVoid = /g) || []).length === 1);
  ok("...and its explanation too — one sentence, not two spellings",
     (code.match(/const STOP_VOID_WHY = /g) || []).length === 1);
  /* TWO CALL SITES: the radar overlay and the conviction card. The
     declaration is `const stopVoid = (live, stop) =>` and does not match
     `stopVoid(`, which is why this is 2 and not 3 — the first draft said 3
     and failed, which is the check working on itself.
     An EXACT count, not >=: the dangerous direction is a new surface that
     prints a stop beside a live price and never asks. */
  const uses = (code.match(/\bstopVoid\(/g) || []).length;
  ok("both surfaces that show a stop beside a live price call it", uses === 2, uses);
  ok("the radar overlay asks the rule rather than re-deriving it",
     /const hit = stopVoid\(v\.price, s\);/.test(code));
  ok("the conviction card decides once, before it renders anything",
     /const voided = stopVoid\(p\._live && p\._live\.price, p\.stop\);/.test(code));
  ok("a voided card says so above the plan it invalidates",
     /class="cv-void"/.test(code) && /lv-plan\$\{voided \? ' is-void' : ''\}/.test(code));
  /* THE SCORE IS STAMPED, NEVER RECOMPUTED. Inventing a fresh number in the
     browser is the fault this site avoids everywhere else; a score that goes
     on reading as current is the fault directly above. */
  ok("the score keeps its value and says when it was taken",
     /\$\{voided \? ' <i>at build<\/i>' : ''\}/.test(code));
  /* The stop path and scale-out restate the levels as instructions one block
     below the strike-through, and read live until this wrapped them. */
  ok("the stop path goes with the plan",
     /class="lv-trail-void"/.test(code) && /\.lv-trail-void\{/.test(CSS));
  /* This file declares no --t-* scale, so a bare var() would delete the whole
     declaration. Same rule the brief's fundamentals block is held to. */
  for (const m of (CSS.match(/\.cv-void[\s\S]*?\}/) || [""])[0].matchAll(/var\(--[\w-]+\)/g)) {
    ok(`the void banner's ${m[0]} carries a literal fallback`, false, m[0]);
  }
  ok("the void banner's custom properties all carry fallbacks", true);

  /* ── AND THE CELLS THAT COULD NEVER FILL ─────────────────────────────────
   * The slate's Volatility, 3Y CAGR, ROCE trend and Results cells read the
   * SCREEN global, which on the front page is permanently null — the heavy
   * pass resolves the rows and never calls setScreen(). So the "filled only
   * for a reader who has been to /screen this session" fallback was the only
   * path, and four cells were empty on every visit. The rows are right there
   * in FRONT_SCREEN, which this route holds for the heatmap strip. */
  ok("the conviction slate reads the screen this route is actually holding",
     /const cvRows = FRONT_SCREEN \|\| SCREEN;/.test(code));
}

/* ── THE WATCHDOG HAD NO TEST OF ANY KIND ────────────────────────────────────
 *
 * It is the thing that repairs a dropped scheduled run in BOTH repos, it
 * exists because GitHub's scheduler was measured dropping a 05:00 slot and
 * both of its retries, and nothing anywhere checked its arithmetic or its
 * inventory.
 *
 * It also holds its OWN COPY of a schedule that lives in another repo's
 * workflow files. That coupling cannot be checked from here — the crons are
 * not in this checkout — so what is checked instead is the shape that made
 * the last two incidents possible: a slot that names work nothing can do, and
 * an inventory that changed without anyone meaning it to. */
{
  /* ── THIS GUARD MUST RUN BEFORE `npm ci`, SO WHAT IT IMPORTS MUST TOO ─────
   *
   * deploy.yml runs `node test/guard.mjs` at step 4 and `npm ci` at step 6, on
   * purpose: a static guard that needs an install is not a fast fail.
   *
   * The first version of the checks below imported src/watchdog.js, which
   * opens with `import { db } from "./api/_db.js"` and reaches
   * @libsql/client. It passed locally, where node_modules exists, and took
   * main's deploy down with ERR_MODULE_NOT_FOUND at the first step in under a
   * second — the site did not ship. Reproduced afterwards by moving
   * node_modules aside, which is the only way to run this the way CI does.
   *
   * So: every module this file reaches, transitively, may import node:
   * builtins and relative paths and NOTHING ELSE. A bare specifier is a
   * package, a package needs an install, and an install is two steps away. */
  {
    const seen = new Set(), bad = [];
    const walk = (file) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) { bad.push(`${file} -> ${spec}`); continue; }
        walk(join(dirname(file), spec));
      }
    };
    walk("test/guard.mjs");
    ok("nothing this guard imports needs an install — it runs before npm ci",
       bad.length === 0, bad);
  }

  /* ── AND THE TWO WORKFLOWS THAT MAKE THAT SENTENCE TRUE ──────────────────
   *
   * The check above is only worth anything while the guard actually runs in a
   * bare checkout. Two files decide that and neither is obvious from here.
   *
   * deploy.yml runs it as its first step, before `npm ci`. checks.yml runs it
   * on every pull request and installs NOTHING — which is what makes a PR
   * reproduce the deploy's environment rather than a developer's. An
   * `npm ci` added to either one ahead of the guard would leave every check
   * passing while the deploy that matters still broke, which is precisely
   * what happened on 2026-09-20 with no PR workflow at all. */
  {
    const DEPLOY = readFileSync(".github/workflows/deploy.yml", "utf8");
    ok("a pull-request workflow exists at all — merging is not the first test",
       existsSync(".github/workflows/checks.yml"));
    /* COMMENTS STRIPPED FIRST. That file's header explains why it does not
       run `npm ci` and why test/ui.mjs is deliberately absent — and the first
       version of these checks read the prose and failed on both, reporting the
       explanation as the offence. Same trap this file already has a note about
       one screen up: a check that matches its own documentation. */
    const yamlCode = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const CHECKS = existsSync(".github/workflows/checks.yml")
      ? yamlCode(readFileSync(".github/workflows/checks.yml", "utf8")) : "";
    ok("it runs on pull_request", /^on:\s*$[\s\S]*?^\s{2}pull_request:/m.test(CHECKS));
    ok("it runs the guard", /node test\/guard\.mjs/.test(CHECKS));
    ok("it installs nothing, so a PR runs the guard the way the deploy does",
       !/npm (ci|install)/.test(CHECKS));
    /* ui.mjs drives a real browser against a running server. It belongs after
       a deploy, against the thing that was deployed — deploy.yml runs it
       there. On a diff it would be slow and flaky and prove nothing. */
    ok("it does NOT try to run the live UI suite", !/test\/ui\.mjs/.test(CHECKS));

    const dep = yamlCode(DEPLOY);
    const gAt = dep.indexOf("node test/guard.mjs");
    const iAt = dep.indexOf("npm ci");
    ok("the deploy still runs the guard before it installs", gAt > -1 && iAt > -1 && gAt < iAt,
       `guard@${gAt} npm ci@${iAt}`);

    /* ── THE POST-DEPLOY SUITE WAITS ON CONDITIONS, NOT ON A CLOCK ─────────
     *
     * Measured on run 202: the deploy took 19m27s, of which ui.mjs was 18m20s
     * and the sleeps were nearly all of that — 28 navigations at ten seconds
     * each accounted for 285 of one section's 285 seconds. On a PRIVATE repo
     * those are metered minutes, and on 2026-09-20 the account's Actions
     * allowance ran out and the feed sync stopped for a day.
     *
     * settled() can never be slower than the sleep it replaced (each call
     * passes its old duration as the cap), so the way this regresses is not a
     * timeout creeping up — it is somebody reaching for waitForTimeout(SETTLE)
     * again because it is the shorter thing to type. */
    const UI = readFileSync("test/ui.mjs", "utf8");
    ok("the UI suite has a settled() that waits on the page, not the clock",
       /const settled = \(page, cap = SETTLE/.test(UI));
    const uiCode = UI.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    const sleeps = (uiCode.match(/waitForTimeout\(SETTLE/g) || []).length;
    ok("no navigation sleeps on a fixed SETTLE any more", sleeps === 0, sleeps);
    /* Every context must carry the probe settled() reads, or it silently
       falls through to the DOM-only half of the condition. */
    ok("every browser context goes through newCtx, which installs the probe",
       (uiCode.match(/browser\.newContext\(/g) || []).length === 1, "only newCtx may call it");
  }

  ok("the watchdog watches something", WATCH.length === 4, WATCH.length);
  for (const w of WATCH) {
    ok(`${w.file}: says which repo, and why it is watched`,
       /^[\w-]+\/[\w-]+$/.test(w.repo || "") && !!w.why && w.why.length > 8, w);
    ok(`${w.file}: has at least one slot`, (w.slots || []).length > 0);
    for (const sl of w.slots || []) {
      const at = `${w.file} ${String(sl.h).padStart(2, "0")}:${String(sl.m).padStart(2, "0")}Z`;
      ok(`${at}: is a real UTC time on real weekdays`,
         Number.isInteger(sl.h) && sl.h >= 0 && sl.h <= 23 &&
         Number.isInteger(sl.m) && sl.m >= 0 && sl.m <= 59 &&
         Array.isArray(sl.dow) && sl.dow.length > 0 &&
         sl.dow.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), sl);
    }
  }

  /* A DISPATCH THAT NAMES NO WORK SENDS NOTHING. The scan and brief entries
   * pass `inputs` to workflow_dispatch; an entry that forgot them dispatched
   * a workflow whose every slot arm fell through to SLOT="" and which then
   * did nothing at all, green. */
  const scan = WATCH.find((w) => w.file === "daily_scan.yml");
  const brief = WATCH.find((w) => w.file === "scheduled_tasks.yml");
  ok("the scan and the briefs are both watched", !!scan && !!brief);
  for (const sl of scan.slots) {
    ok(`daily_scan ${sl.h}:00Z names the slot it is dispatching`, !!(sl.inputs || {}).slot, sl);
    /* job is the job_runs key the watchdog asks "did the WORK land?". It is
     * _scan_job(slot) over there — `scan_` + the slot — and a mismatch makes
     * the watchdog query a row that is never written, so it concludes the
     * work never happened and dispatches forever. */
    ok(`daily_scan ${sl.inputs.slot}: its ledger key matches its slot`,
       sl.job === "scan_" + sl.inputs.slot, sl.job);
  }
  /* AN EXACT SET, NOT A COUNT >= n. The dangerous direction is a slot quietly
   * disappearing — which is how `midday` came to have a cron in daily_scan.yml
   * and no watchdog entry, leaving the one scan that runs while the market is
   * open as the only unwatched one. `>=` would pass through that. Adding or
   * removing a slot means editing this line, on purpose, in the same commit. */
  const slotNames = scan.slots.map((x) => x.inputs.slot).sort().join(",");
  ok("the scan's watched slots are exactly midday, eod and weekend",
     slotNames === "eod,midday,weekend", slotNames);

  /* ── dueSlot, THE ARITHMETIC ─────────────────────────────────────────────
   * Everything above is inventory. This is the function that decides whether
   * a missed slot is noticed, and it had never been executed by a test. */
  const utc = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi));
  // 2026-09-16 is a Wednesday.
  const midday = scan.slots.find((x) => x.inputs.slot === "midday");
  /* dueSlot LOOKS BACK TWO DAYS ON PURPOSE — a Friday-evening slot is still
   * the newest one on a Sunday, and "nothing due" there would hide a real
   * outage. So these assert WHICH INSTANT came back, never that nothing did:
   * the first draft of these checks expected null and failed, because a
   * yesterday's slot was legitimately being returned. */
  const iso = (r) => (r ? new Date(r.at).toISOString().slice(0, 16) : null);
  ok("a midday slot well past its grace is claimed today",
     iso(dueSlot(utc(2026, 8, 16, 6, GRACE_MIN + 8), [midday])) === "2026-09-16T06:00",
     iso(dueSlot(utc(2026, 8, 16, 6, GRACE_MIN + 8), [midday])));
  ok("...and INSIDE the grace today's is not claimed — yesterday's is the newest",
     iso(dueSlot(utc(2026, 8, 16, 6, GRACE_MIN - 5), [midday])) === "2026-09-15T06:00",
     iso(dueSlot(utc(2026, 8, 16, 6, GRACE_MIN - 5), [midday])));
  // 2026-09-20 is a Sunday. A weekday slot has none of its own that day, so
  // the newest it can offer is Friday's — not Saturday's, which does not exist.
  ok("a weekday slot on a Sunday reaches back to Friday, not to a day it never ran",
     iso(dueSlot(utc(2026, 8, 20, 6, 30), [midday])) === "2026-09-18T06:00",
     iso(dueSlot(utc(2026, 8, 20, 6, 30), [midday])));
  /* THE NEWEST SLOT WINS, and it must be able to reach back across a day —
   * a Friday-evening slot is still the newest one on a Saturday morning. */
  const eod = scan.slots.find((x) => x.inputs.slot === "eod");
  ok("the most recent passed slot is the one returned",
     (dueSlot(utc(2026, 8, 16, 13, 0), [midday, eod]) || {}).inputs?.slot === "eod");
  ok("a slot from yesterday is still reachable this morning",
     (dueSlot(utc(2026, 8, 17, 2, 0), [midday, eod]) || {}).inputs?.slot === "eod");
  /* THE GRACE IS A SAFETY MARGIN, NOT A CONSTANT TO NUDGE. Twelve minutes is
     one Cloudflare tick past the slot; the newspaper entry overrides it to
     three hours because a duplicate build races a commit. */
  ok("the default grace is one watchdog tick past the slot",
     GRACE_MIN >= 10 && GRACE_MIN <= 20, GRACE_MIN);
  const paper = WATCH.find((w) => w.file === "newspaper.yml");
  ok("the unguarded build keeps its long grace — a duplicate races a commit",
     paper.graceMin >= 120, paper.graceMin);
}

/* ── THE DESIGN DNA IS EXECUTABLE, OR IT WAS TRUE ONCE ───────────────────────
 * DESIGN.md states the rules the three stylesheets are built on. A design
 * document nobody checks is a document that described the CSS on the day it
 * was written; every one of the forty decisions already recorded in comments
 * got there BECAUSE the previous statement of it had drifted.
 *
 * Five rules, each with the incident behind it named in DESIGN.md itself. */
{
  const DNA = existsSync("DESIGN.md") ? readFileSync("DESIGN.md", "utf8") : "";
  const GEMSCSS = readFileSync("public/gems.css", "utf8");
  ok("DESIGN.md exists — the stylesheets have a stated brief", DNA.length > 2000, DNA.length);

  /* 1. Every token the document names is really declared. A DNA that cites a
   *    token the CSS does not define is the var()-resolves-to-nothing fault
   *    one level up: it reads correct and specifies nothing. */
  {
    const declared = new Set();
    for (const src of [CSS, GEMSCSS]) {
      for (const m of src.matchAll(/(--[a-z0-9][a-z0-9-]*)\s*:/g)) declared.add(m[1]);
    }
    const named = new Set([...DNA.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)].map(x => x[1]));
    const ghosts = [...named].filter(t => !declared.has(t));
    ok("every token DESIGN.md names is declared in a stylesheet", ghosts.length === 0, ghosts);
    ok("DESIGN.md names enough tokens to be a specification", named.size >= 25, named.size);
  }

  /* 2. Elevation exists in BOTH themes of BOTH sheets. The incident: five
   *    bespoke shadows, every one rgba(0,0,0,..), so on the dark theme the
   *    command palette, the tab menu, the toast and the to-top button had no
   *    separation from a #0C1017 page and nothing reported it. A step declared
   *    only in light is that bug with a token name on it. */
  for (const [label, src] of [["signal.css", CSS], ["gems.css", GEMSCSS]]) {
    const dark = (src.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/) || [""])[0];
    const light = src.slice(0, src.indexOf(dark) >= 0 ? src.indexOf(dark) : src.length);
    for (const n of [1, 2, 3, 4]) {
      ok(`${label} declares --e-${n} in light`, new RegExp(`--e-${n}\\s*:`).test(light));
      ok(`${label} declares --e-${n} in dark`, new RegExp(`--e-${n}\\s*:`).test(dark));
    }
  }

  /* 3. No elevation is written by hand. Rings (inset 0 0 0 1px) and the
   *    keyframes that flash a changed figure are not elevation and are not
   *    caught by this — a shadow with a BLUR and an offset is. */
  {
    const hand = [];
    for (const [label, src] of [["signal.css", CSS], ["gems.css", GEMSCSS]]) {
      const body = src.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of body.matchAll(/box-shadow:\s*([^;}]+)/g)) {
        const v = m[1];
        if (/var\(--e-[1-4]\)/.test(v)) continue;
        if (/^\s*none/.test(v)) continue;
        if (/inset\s+0\s+0\s+0/.test(v)) continue;          // a ring
        if (/0\s+0\s+0\s+\d/.test(v)) continue;             // a pulse/flash ring
        hand.push(`${label}:${lineOf(body, m.index)}  ${v.trim().slice(0, 48)}`);
      }
    }
    ok("no drop shadow is written by hand — elevation goes through --e-1..4",
       hand.length === 0, hand);
  }

  /* 4. The type scale is complete in signal.css. It was 25 distinct sizes
   *    before the scale was declared and 6 after — 11.5px beside 12px is not a
   *    level of hierarchy, it is two people guessing on different days. */
  {
    const body = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const lits = [
      ...body.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px(?![\w(])/g),
      ...body.matchAll(/font:\s*(?:\d{3}\s+|italic\s+|normal\s+)*(\d+(?:\.\d+)?)px\//g),
    ].map(m => m[1]);
    ok("signal.css writes no literal font-size — every size is a scale step",
       lits.length === 0, [...new Set(lits)]);
  }

  /* 5. gems.css is a RATCHET, not a rule. It carries 21 distinct literal sizes
   *    and three of them are smaller than --t-1, so snapping them up is a real
   *    change to a dense sheet that could not be verified when the scale was
   *    added. The count may fall. It may not rise. */
  {
    const body = GEMSCSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const n = [
      ...body.matchAll(/font-size:\s*\d+(?:\.\d+)?px(?![\w(])/g),
      ...body.matchAll(/font:\s*(?:\d{3}\s+|italic\s+|normal\s+)*\d+(?:\.\d+)?px\//g),
    ].length;
    /* 46 as measured on 2026-09-22, across 21 distinct values. Lower this
       number as rules are converted; never raise it. */
    const CEILING = 46;
    ok(`gems.css literal font-sizes have not grown past ${CEILING}`, n <= CEILING, n);
  }

  /* 6. One motion vocabulary across both bundles. --t-press lived in gems.css
   *    alone, so the two sheets deliberately brought onto one vocabulary
   *    disagreed about the single duration a finger can feel. */
  for (const [label, src] of [["signal.css", CSS], ["gems.css", GEMSCSS]]) {
    for (const t of ["--t-press", "--t-fast", "--t-mid", "--t-slow", "--ease", "--ease-out"]) {
      ok(`${label} declares ${t}`, new RegExp(`${t}\\s*:`).test(src));
    }
  }
}

/* ── THE LIVE PAGE HAS TO BE LIVE OUT LOUD TOO ──────────────────────────────
 * The page re-fetches every sixty seconds and marks the cells that moved by
 * flashing them green or red. That was the ENTIRE feedback channel, and all of
 * it visual: a screen-reader user was told nothing when a number moved under
 * them, on a site whose whole subject is numbers moving.
 *
 * Four properties, each of which was wrong in a draft of the fix. */
{
  ok("the shell carries one polite live region",
     /id="liveNews"[^>]*role="status"/.test(HTML)
     && /id="liveNews"[^>]*aria-live="polite"/.test(HTML)
     && /id="liveNews"[^>]*aria-atomic="true"/.test(HTML));

  /* OUTSIDE <main>. main is replaced wholesale on every repaint, and a live
   * region that is removed and re-inserted is not announced: assistive tech
   * tracks the node, and a fresh node with text already in it reads as a new
   * element rather than a change to an existing one. */
  {
    /* Comments stripped first: the note ABOVE the region explains why it is
       outside <main> and therefore contains the string, which the first
       version of this check matched before the real tag. */
    const bare = HTML.replace(/<!--[\s\S]*?-->/g, "");
    const i = bare.indexOf('id="liveNews"');
    const m = bare.indexOf('<main');
    ok("the live region is outside <main>, which is replaced on every repaint",
       i > 0 && m > 0 && i < m, { liveNews: i, main: m });
  }

  /* THE DIFF IS TAKEN ONCE AND USED TWICE. It used to be computed inside the
   * flash, which returns early under prefers-reduced-motion — so for a reader
   * who had asked for less movement the diff was never taken at all, and an
   * announcement built on it would have been silent for exactly the readers
   * most likely to need it. */
  ok("the diff is its own function", /function diffNums\(before\)/.test(JS));
  ok("the refresh takes the diff once", /const moved = diffNums\(before\);/.test(JS));
  ok("...and both consumers are called with it",
     /flashChanged\(moved\);/.test(JS) && /announceChanged\(moved\);/.test(JS));

  /* AN ANNOUNCEMENT IS NOT AN ANIMATION. Gating it on prefers-reduced-motion
   * is the one-line change that silently reinstates the whole defect. */
  {
    const fn = (JS.match(/function announceChanged\(moved\) \{[\s\S]*?\n  \}/) || [""])[0];
    ok("announceChanged exists", fn.length > 0);
    ok("it is not gated on prefers-reduced-motion — an announcement is not an animation",
       !/reduced-motion/.test(fn));
    ok("it says nothing when nothing moved", /if \(!moved\.length\)/.test(fn));
    /* A SUMMARY, NOT A FIREHOSE. A refresh can move sixty cells; reading sixty
     * aloud takes longer than the interval before the next refresh. */
    ok("it names a bounded number of movers and counts the rest",
       /\.slice\(0, 3\)/.test(fn) && /more/.test(fn), fn.slice(0, 0));
    /* THE CLEAR HAS TO LAND IN A LATER TASK. The accessibility tree is
     * computed when the task ends, so a clear and a set in the same task are
     * only ever seen as the set — the first version did exactly that and a
     * MutationObserver recorded the final text for both records. */
    ok("the re-announce clears in one task and sets in another",
       /textContent = '';[\s\S]*setTimeout\(\(\) => \{ el\.textContent = sentence; \}/.test(fn));
    ok("...and a refresh landing on a pending one replaces it rather than queueing",
       /clearTimeout\(announceChanged\._t\)/.test(fn));
  }
}

/* ── A NUMBER TYPED BESIDE A LIST IS A CLAIM THE LIST WILL NEVER GROW ────────
 *
 * Both of these shipped, and both are the same fault the ticker lead was
 * already fixed for ("COUNTED, NOT SPELLED OUT"):
 *
 *   · /discover led with "Seven ways into the same N names" over a DISCOVER
 *     registry of ELEVEN. Four doors were added and the sentence above them
 *     was not. Its meta description then named seven of the eleven in a
 *     sentence that reads as exhaustive — and a meta description is what a
 *     search result and a link unfurl quote.
 *   · /engines' meta description said "Nine engines". ENGINE_BOOK.keys()
 *     returns EIGHT and has since magic was retired. This is the number the
 *     sibling repo's notes already record as having read 8 on one page and 9
 *     on another; it was still reading 9 in the one place nobody re-reads.
 *
 * Four other figures in the same copy were checked against their sources and
 * are CORRECT, so they are left alone rather than scrubbed: /markets' 71 is
 * 56 static instruments plus three live segments of five, /radar's eight is
 * slice(0, 8), /research's three is the research roster, and /reads' seven is
 * the studies in an edition. The rule is not "no numbers in prose". */
{
  const SRC = JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
                 seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

  /* The doors, counted out of the registry itself. */
  const disc = (JS.match(/const DISCOVER = \[([\s\S]*?)\n  \];/) || ["", ""])[1];
  const nDoors = (disc.match(/\n    \['\//g) || []).length;
  ok("the DISCOVER registry can be counted", nDoors >= 5, nDoors);

  /* The engines, out of the one registry both bundles share. */
  const ENG = readFileSync("public/engines.js", "utf8");
  const w = {};
  new Function("window", ENG)(w);
  const nEngines = w.ENGINE_BOOK.keys().length;
  ok("the engine registry can be counted", nEngines >= 5, nEngines);

  /* THE LEAD COUNTS, IT DOES NOT SPELL. */
  ok("the discover lead counts the registry rather than asserting a figure",
     /\$\{DISCOVER\.length\} ways into/.test(JS));

  /* NO STRING MAY SPELL A COUNT THAT DISAGREES WITH ITS REGISTRY. Both the
   * digit and the word form, because "9 engines" and "nine engines" are the
   * same claim. */
  const wrong = [];
  const num = t => (/^\d+$/.test(t) ? Number(t) : WORD[t.toLowerCase()]);
  /* THE RESEARCH FLOOR IS A DIFFERENT POPULATION and says so in its own
   * sentence. "Three engines that have not earned capital" is not a claim
   * about the published book, and a check that cannot tell them apart would
   * either fail on correct copy or be switched off. The enclosing sentence is
   * read, not just the two words around the number. */
  const ELSEWHERE = /research|not earned|none of them cleared|still being tested|BUOY|ANCHOR|BEDROCK/i;
  const sentence = (src, i) => {
    const a = src.lastIndexOf("\n", i), b = src.indexOf("\n", i);
    return src.slice(a < 0 ? 0 : a, b < 0 ? src.length : b);
  };
  const scan = (noun, truth) => {
    const re = new RegExp(
      `(\\d{1,3}|${Object.keys(WORD).join("|")})\\s+${noun}`, "gi");
    for (const m of SRC.matchAll(re)) {
      const n = num(m[1]);
      if (n === undefined || n === truth) continue;
      if (ELSEWHERE.test(sentence(SRC, m.index))) continue;
      wrong.push(`"${m[0]}" but the registry holds ${truth}  (line ${lineOf(SRC, m.index)})`);
    }
  };
  scan("engines", nEngines);
  scan("ways into", nDoors);
  /* The front page's own denominator, which read "of 7 engines" after GUST was
     promoted out of research tier and the number beside it was not. */
  ok("the cleared-for-capital tile counts its denominator",
     /`of \$\{engineTally\(\)\.keys\} engines`/.test(JS));
  ok("no copy spells a count its own registry contradicts", wrong.length === 0, wrong);
}

/* ── THE TARGET IS BIGGER THAN THE BUTTON ───────────────────────────────────
 * DESIGN.md claimed "touch targets are 44px minimum" and four controls were
 * not: .icon-btn at 32 (the theme toggle, the menu and the search — on every
 * page, and the most-tapped controls on the site), .wstar at 28, .totop at 42,
 * and a range input at 24. The document was asserting a floor the sheet did
 * not hold, which is the one thing a design document must never do.
 *
 * The fix is a hit area, not a bigger button: growing .icon-btn to 44 puts
 * three 44px boxes in a 64px bar and changes the header's density, and density
 * is the point of this design. Verified with elementFromPoint at 390px — the
 * button answers at 21px from its own centre in all four directions. */
{
  const FLAT = CSS.replace(/\s+/g, " ");
  const hasHit = (cls, w, h) =>
    new RegExp("\\." + cls + "::after\\{[^}]*width:" + w + "px[^}]*height:" + h + "px").test(FLAT);
  ok(".icon-btn carries a 44px hit area", hasHit("icon-btn", 44, 44));
  ok("...and is positioned, or the pseudo resolves against the page instead",
     /\.icon-btn\{position:relative/.test(CSS));
  /* AND THE HIT AREAS MUST NOT OVERLAP. At an 8px gap two 44px areas around
     32px buttons cross by 4px, and in an overlap the later element in the DOM
     wins — a mis-tap, not a bigger target. 32 + 12 puts the centres exactly
     44 apart. Measured at 390px: centre gap 44, no overlap. */
  ok("the header gap keeps two hit areas from crossing",
     /\.bar-right\{[^}]*gap:var\(--s-3\)/.test(CSS));
  /* WIDER, NOT TALLER. A square 44px area around the star would bleed 8px into
     the row above and below, and a tap meant to open that row would save a
     name in this one. 36 is 4px of bleed inside a 40px row. */
  ok(".wstar widens its hit area on the safe axis only", hasHit("wstar", 44, 36));
  ok("...and is positioned", /\.wstar\{position:relative\}/.test(CSS));
  ok(".totop is the full target size — nothing sits beside it",
     /\.totop\{[\s\S]{0,400}?width:44px;height:44px/.test(CSS));
}

/* ── THE SPACING DRIFT IS A RATCHET ─────────────────────────────────────────
 * 1,340 literal px values across every gap, margin and padding in signal.css;
 * 796 already exactly on the scale, 324 BELOW the 4px base (hairline insets, a
 * chip's 2px padding — optical adjustments, not steps), and 220 above the base
 * and off it. 107 of those 220 were the single value 14px, which is why
 * --s-3h is declared rather than 107 rules being moved to 12 or 16.
 *
 * The remaining 113 are held here. They may fall. They may not rise.
 *
 * The 796 on-scale literals are deliberately NOT required to be tokens: the
 * rename changes zero pixels, produces an 800-line diff on a live stylesheet,
 * and would bury every real change in it. */
{
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const SCALE = new Set([4, 8, 12, 14, 16, 24, 32, 48, 64, 96]);
  const props = /(?:gap|row-gap|column-gap|margin|padding)(?:-(?:top|bottom|left|right))?:\s*([^;}]+)/g;
  const off = [];
  for (const m of body.matchAll(props)) {
    for (const px of m[1].matchAll(/(?<![\w.-])(\d+)px/g)) {
      const n = Number(px[1]);
      if (n < 8 || SCALE.has(n)) continue;   // below the base, or on the scale
      off.push(n);
    }
  }
  /* 113 as measured on 2026-09-22. Lower it as rules are converted; never
     raise it — a new off-scale gap must pick a step instead. */
  const CEILING = 113;
  ok(`off-scale spacing has not grown past ${CEILING}`, off.length <= CEILING,
     { count: off.length, values: [...new Set(off)].sort((a, b) => a - b) });
  ok("the half-step is declared, so 14px has a token to reach for",
     /--s-3h\s*:\s*14px/.test(CSS));
  /* THE ONLY HALF-STEP. Three choices inside a 4px range is the drift a scale
     exists to end, so a second one must fail here rather than be argued about
     in review. */
  ok("and it is the only one", (CSS.match(/--s-\d+h\s*:/g) || []).length === 1,
     CSS.match(/--s-\d+h\s*:/g));
}

/* ── ONE SERIF EXCEPTION, AND IT IS NAMED ───────────────────────────────────
 * The note at the top of signal.css said "nothing calls --serif any more; the
 * file is no longer preloaded, so it costs a reader nothing" — true of the
 * TOKEN and misleading about the FACE. The brief's sub-theme reaches Newsreader
 * through --b-serif and sets nine headline roles in it, so every reader who
 * opens /brief downloads it.
 *
 * That is the intended design. What must not happen is the face spreading back
 * across the site one rule at a time, which is exactly how there came to be two
 * display voices the first time. */
{
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const refs = [...body.matchAll(/Newsreader/g)];
  /* Three, exactly: the @font-face family, the woff2 it points at, and
     --b-serif. Nothing else may name it. */
  ok("Newsreader is named exactly three times — its family, its file, its one token",
     refs.length === 3, refs.length);
  ok("...and the second is --b-serif", /--b-serif:'Newsreader'/.test(body));
  /* THE SITE-WIDE TOKENS MUST NOT POINT AT IT. --serif, --disp and --ui are
     the three every other rule reaches through. */
  for (const t of ["--serif", "--disp", "--ui"]) {
    const m = body.match(new RegExp(`${t}:([^;]+);`));
    ok(`${t} resolves to the interface face, not the serif`,
       !!m && !/Newsreader/.test(m[1]), m && m[1]);
  }
  /* AND IT IS NOT PRELOADED. A preload is the highest-priority fetch a page can
     make; spending one on a face used by a single route would cost every other
     route the bandwidth. */
  ok("the serif is not preloaded — one route uses it",
     !/rel="preload"[^>]*Newsreader/.test(HTML));
}

/* ── A PAGE MAY NOT DENY A CAPABILITY IT RENDERS ────────────────────────────
 *
 * /news carried a section called "What is not here" which read: "There is no
 * timestamp, no story clustering and no analysis in it, so this page cannot
 * show time since publication, '+N more sources', an impact grade, or a
 * written why it matters."
 *
 * Three of those four were on the screen directly above it. storyAge(x.at)
 * prints the age on every story the live wire carries; dedupeWire() is TF-IDF
 * clustering with an exact body-match pass in front of it, and the "+N more"
 * byline is its output; the Merged tile counts the clusters it found. The text
 * was written for the MIRRORED daily file — true of that file's timestamps and
 * nothing else — and printed unconditionally.
 *
 * That matters more than a stale sentence, because the fourth item is not a
 * limitation at all: it is this site's central refusal. A reader who notices
 * three of the four claims are false has no reason to read the fourth as a
 * principle rather than another excuse. Both directions fail here — denying a
 * shipped capability, and dropping the refusal. */
{
  const route = (JS.match(/R\['\/news'\] = async \(\) => \{[\s\S]*?\n  \};/) || [""])[0];
  ok("the news route can be read", route.length > 500, route.length);

  /* The three capabilities the page actually ships. */
  ok("the wire prints a story's age", /storyAge\(x\.at\)/.test(route));
  ok("...and the other desks that filed it", /\+\$\{x\._also\.length\} more/.test(route));
  ok("...over real clustering, not a sort", /function dedupeWire\(/.test(JS)
     && /dedupeWire\(/.test(route));

  const copy = (route.match(/sec\('What this page will not do'[\s\S]*?\}\)\);/) || [""])[0];
  ok("the page still says what it will not do", copy.length > 200, copy.length);

  /* IT MUST NOT DENY WHAT IT SHIPS. */
  const denied = [
    ["no story clustering", /no story clustering/i],
    ["cannot show time since publication", /cannot\s+show[^<]*time since publication/i],
    ["denies the +N more byline", /cannot\s+show[^<]*more sources/i],
  ].filter(([, re]) => re.test(copy)).map(([label]) => label);
  ok("it denies nothing the page renders", denied.length === 0, denied);

  /* A TIMESTAMP CLAIM MUST BE SCOPED TO THE FEED ON SCREEN. The live wire
     stamps every story; the mirrored daily file carries none. One sentence
     cannot be true of both, so the section branches on which is serving. */
  ok("the timestamp claim is scoped to the feed actually serving",
     /\$\{live \?/.test(copy));

  /* AND THE REFUSAL MUST SURVIVE. Ranking a headline's importance is the thing
     this site does not do; losing that sentence while tidying the stale ones
     is the opposite failure and just as bad. */
  ok("the refusal to grade a story is still stated",
     /No impact grade/i.test(copy) && /choice, not a\s*\n?\s*missing feed/i.test(copy), copy.slice(0, 0));
}

/* ── THE CLASS CHECK RUNS BOTH WAYS NOW ─────────────────────────────────────
 *
 * Check 4 above runs ONE WAY and over NINE PREFIXES: it asks whether the
 * classes the renderer emits with those prefixes have rules. That is the same
 * shape as the engine roster faults recorded in the sibling repo — "each check
 * used to run one way, from a key somebody had already remembered to name" —
 * so three prefixes nobody thought to add were unchecked in both directions.
 *
 * Read out of the source instead, with a floor on the match count so a pattern
 * that stops matching fails rather than passing everything.
 *
 * NEITHER NUMBER IS ALL DEFECT, and the names say so:
 *
 *  · A class with no rule is usually a WRAPPER or a semantic hook — .hero-l is
 *    a bare div inside .hero and needs nothing. Sometimes it is a refactor that
 *    renamed an element and left the style on the old name, which is the
 *    incident check 4 was written for.
 *  · A rule with no emitter is dead weight, and it misleads: DESIGN.md cited
 *    .tabg-m as a live example of elevation while writing the token, and
 *    nothing in this repo emits .tabg-m.
 *
 * So both are ratchets. They may fall. They may not rise. */
{
  const BF = readFileSync("public/brief_fundamentals.js", "utf8");
  /* BF IS BOTH. It carries its own <style> block on purpose — a companion .css
     would need allow-listing in four places here and a fifth over there, and
     the markup could then reach a page whose stylesheet did not. So it is a
     sheet as well as an emitter, and scanning it as only the latter reported
     eighteen bf- classes as unstyled when every one of them is styled inside
     the file that emits it. */
  const SHEETS = CSS + readFileSync("public/heat.css", "utf8") + BF;
  const EMITTERS = JS + HTML + BF + readFileSync("public/heatcore.js", "utf8");

  /* ── forward: emitted, styled nowhere ── */
  const emitted = new Set();
  for (const m of EMITTERS.matchAll(/class="([a-z0-9 _-]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) emitted.add(c);
  }
  /* THE FLOOR. A regex that stops matching would otherwise report zero
     unstyled classes and pass, which is the failure mode of every check that
     scans rather than enumerates. */
  ok("the emitter scan still finds classes", emitted.size > 600, emitted.size);
  const unstyled = [...emitted].filter(c => !SHEETS.includes("." + c)).sort();
  /* 12 as measured on 2026-09-22, across signal.css and heat.css together —
     the two sheets index.html actually loads. Checking against one of them was
     what made this look like 38. */
  const UNSTYLED_CEILING = 12;
  ok(`classes with no rule anywhere have not grown past ${UNSTYLED_CEILING}`,
     unstyled.length <= UNSTYLED_CEILING, { count: unstyled.length, unstyled });

  /* ── reverse: styled, emitted nowhere ── */
  const bare = SHEETS.replace(/\/\*[\s\S]*?\*\//g, "");
  const styled = new Set([...bare.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  ok("the stylesheet scan still finds classes", styled.size > 800, styled.size);
  /* A class BUILT from a prefix and a variable cannot be found by name, so the
     prefixes are read out of the source too rather than listed by hand. */
  const dynamic = new Set([
    ...[...EMITTERS.matchAll(/([a-z][\w-]*-)\$\{/g)].map(m => m[1]),
    /* THE PREFIX IS RARELY THE WHOLE STRING. heatcore builds its tiles with
       `'<button class="ht ht-' + d + k + ...'` — the prefix sits at the END of
       a long literal, so a pattern anchored to the opening quote finds nothing
       and nine live ht- classes were reported as dead. Anchored to the closing
       quote and the concatenation instead. */
    ...[...EMITTERS.matchAll(/([a-z][\w-]*-)['"]\s*\+/g)].map(m => m[1]),
  ]);
  ok("the dynamic-prefix scan still finds prefixes", dynamic.size >= 8, dynamic.size);
  const unreachable = [...styled]
    .filter(c => !EMITTERS.includes(c) && ![...dynamic].some(p => c.startsWith(p)))
    .sort();
  /* ZERO. It was 37 — 107 rules and 314 declarations, 5.4% of the sheet,
     styling components nothing renders — and they are gone, so the ratchet
     sits on the floor. A rule written before its markup will fail here; that
     is the intended cost, and raising this number is a one-line change that
     has to carry a reason. */
  const UNREACHABLE_CEILING = 0;
  ok(`rules with no emitter have not grown past ${UNREACHABLE_CEILING}`,
     unreachable.length <= UNREACHABLE_CEILING,
     { count: unreachable.length, unreachable });
}

/* ── THE LIVE OVERLAY MUST NOT RE-IMPLEMENT A RULE ──────────────────────────
 *
 * offHigh() exists because "off its high" must not be a positive number: a
 * price ABOVE the 52-week high is not a distance from it, it is a new high,
 * and rendering "+0.4%" under that label reads as 0.4% BELOW. FINCABLES showed
 * it at build before the helper existed.
 *
 * The live overlay then wrote `d.toFixed(1) + '%'` straight into the cell and
 * reinstated the whole thing. Measured on ACMESOLAR, 2026-09-22: live ₹458.65
 * against a 52-week high of ₹440.70 printed on the same card, rendering
 * "4.1% · Off its high" — 4.1% above, labelled as below, in the up colour so
 * it looked deliberate.
 *
 * The stop comparison three lines under it carries the same lesson in its own
 * comment: "stopVoid(), not `v.price <= s`. This comparison used to BE the
 * rule, which is why the rule existed only here." */
{
  const ov = (JS.match(/const fh = el\.querySelector\('\[data-fhigh\]'\);[\s\S]*?\n          \}/) || [""])[0];
  ok("the live overlay re-reads the 52-week high", ov.length > 100, ov.length);
  ok("...through offHigh(), not a raw percentage", /offHigh\(\(v\.price - hi\) \/ hi \* 100\)/.test(ov));
  ok("...and never writes toFixed straight into the cell",
     !/fh\.textContent\s*=\s*d\.toFixed/.test(ov), ov.slice(0, 0));
  /* THE LABEL MOVES WITH THE VALUE. The <em> is chosen at build — "52-week
     high" at one, "Off its high" otherwise — so writing only the <b> leaves a
     correct number under a stale heading, the same defect one element left. */
  ok("...and moves the label with it", /lab\.textContent = o\.txt === 'at a new high'/.test(ov));

  /* ── THE BACK-TO-TOP CONTROL DOES NOT EXIST ON A PHONE ──────────────────
   * It floated over the content at 40x40 above the tab bar, and on a 390px
   * screen there is nothing to float over except content: measured on /radar,
   * the circle sat on a card's right-aligned Institutional score. It is also
   * redundant below 760px, where the tab bar is pinned to the bottom of the
   * viewport and tapping the tab you are on scrolls to the top. */
  ok("the back-to-top control is removed below 760px",
     /@media\(max-width:760px\)\{\s*\.totop\{display:none\}\s*\}/.test(CSS.replace(/\s*\n\s*/g, "")));
  /* AND NOTHING MAY SHRINK IT BELOW THE FLOOR where it does exist. The old
     mobile rule set it to 40, under the target size this sheet holds
     everywhere else — and raising that to 44 would have covered MORE of the
     number it was already covering, which is why it was removed instead. */
  {
    const sized = [...CSS.matchAll(/\.totop\{[^}]*?width:(\d+)px/g)].map(m => Number(m[1]));
    ok("every .totop rule that sizes it meets the 44px floor",
       sized.length > 0 && sized.every(n => n >= 44), sized);
  }

  /* ── THE SAME ROUTE IS A SCROLL, NOT A REBUILD ─────────────────────────
   * go() called render() when the path had not changed, tearing the route
   * down and painting it again from the feeds for a page nothing had changed
   * on. On a phone this IS the back-to-top control now, so it has to be a
   * scroll rather than a flash of skeletons. */
  {
    const fn = (JS.match(/const go = \(path, \{ replace = false \} = \{\}\) => \{[\s\S]*?\n  \};/) || [""])[0];
    ok("go() exists", fn.length > 100, fn.length);
    ok("navigating to the route you are on scrolls instead of rebuilding",
       /if \(to === location\.pathname\) \{[\s\S]*?window\.scrollTo\(\{ top: 0/.test(fn)
       && !/if \(to === location\.pathname\) \{ render\(\)/.test(fn));
  }
}

/* ── FOUR MONTHS IS NOT A YEAR, AND THE LABEL HAS TO SAY WHICH ──────────────
 *
 * The screen nulls high52 under 240 bars, correctly — everything derived from
 * it claims a year. But a high is NOT an average: the max of 96 bars is the
 * true max of those 96 bars, and blanking it published "—" for a fact the
 * series plainly contains, on 69 of 983 names. LENSKART, GROWW, EMMVEE and the
 * rest of the recent listings, plus the demerged tickers whose series restarts
 * — VEDL, SKFINDIA, SKFINDUS, TIMEX. Each still carried a verdict with an
 * entry, a stop and a target while the screen could not say where the price
 * sat in its own range.
 *
 * The producer now publishes that window under its own keys with the session
 * count. THIS is the only place that decides what to call it, and the failure
 * mode in the other direction — printing "52-week" over 96 sessions — is the
 * false sentence the producer's gate exists to prevent. */
{
  const strip = (JS.match(/const factsStrip = \(r, opts\) => \{[\s\S]*?\n  \};/) || [""])[0];
  ok("the facts strip can be read", strip.length > 500, strip.length);

  ok("it falls back to the shorter window when there is no year",
     /r\.rng_lo != null && r\.rng_hi != null/.test(strip));
  ok("...and reads that window's own off-high, not the year's",
     /r\.from_high : short \? r\.rng_from_hi/.test(strip));
  /* THE LABEL IS BUILT FROM THE SESSION COUNT. A hardcoded "52w" on the
     fallback path is the whole bug, re-typed. */
  ok("...and names the window from its session count",
     /\$\{sess\}-session/.test(strip));
  ok("...so a short window never renders as 52w",
     !/short \? '52w/.test(strip) && !/52w range`/.test(strip.replace(/'52w range'/g, "")));

  /* AT A NEW HIGH IS THE DANGEROUS ONE. offHigh() returns the same "at a new
     high" string either way, and the label beside it is what says whether the
     high is a year's or a quarter's. */
  ok("a new high is labelled with its own window, not with a year",
     /o\.txt === 'at a new high' \? `\$\{win \|\| '52w'\} high`/.test(strip));

  /* AND THE LIVE OVERLAY MUST NOT RE-TYPE IT EITHER. It rewrites this label
     on every quote, so a hardcoded year there reinstates the fault sixty
     seconds after the page loads. */
  {
    const ov = (JS.match(/const fh = el\.querySelector\('\[data-fhigh\]'\);[\s\S]*?\n          \}/) || [""])[0];
    ok("the strip hands the overlay the window", /data-fwin="/.test(strip));
    ok("...and the overlay reads it rather than assuming a year",
       /getAttribute\('data-fwin'\)/.test(ov));
    ok("...and never hardcodes 52-week in the live label",
       !/'52-week high'/.test(ov), ov.slice(0, 0));
  }
}

console.log(fails
  ? `\n${fails} of ${checks} guard checks FAILED`
  : `\n${checks}/${checks} guard checks pass`);
process.exit(fails ? 1 : 0);
