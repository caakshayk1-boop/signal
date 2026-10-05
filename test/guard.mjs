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

let fails = 0, checks = 0, retired = 0;
/* SIGNAL V2 (2026-10-01). These checks pinned V1 surfaces that no longer exist
   — the ledger, the engine floor, the old front page and the old brief. They
   are retired BY NAME, listed here with the reason, and reported as retired,
   so a reader of this file can see exactly what stopped being enforced and
   why. The V2 equivalents are the "Signal V2" block at the end. */
const RETIRED_WITH_V1 = new Set([
  "a lane's record is read from the engine's backtest block",
  "the provenance links moved to the Ledger rather than being dropped",
  "the winrate figure carries an explanation",
  "the brief decides on one flag, and every consumer reads it",
  "the brief's second target comes through lvl(), which treats 0 as absent",
  "a one-target setup still draws to scale rather than drawing nothing",
  "reward-to-risk against a target that is not published is null, not a repeat of T1",
  "the brief has a business section",
  "it is in document order too, not just in the nav",
  "the section calls the shared renderer rather than carrying its own copy",
  "a renderer that did not arrive produces a notice, not a hole",
  "the caller supplies its own screen link",
  "the brief declares its sections",
  "every section has a digit that jumps to it",
  "the conviction slate reads the screen this route is actually holding",
  "the engine registry can be counted",
  "the cleared-for-capital tile counts its denominator",
  "no copy spells a count its own registry contradicts",
  "the tile's open count is the bucket's, not a second definition",
  "the front page leads with the published barometer.json",
  "wins and losses are not printed as advancing and declining",
  "the front page requests its heavy feeds before awaiting the first wave",
  "the ledger offers a Closed filter",
  "the front page lists recent closes from the ledger, losses included",
  "toward a verdict draws each engine against the 30-trade rule",
  "the trailing-window chip says when nothing closed, never a zero",
  "Brief is in the bar — on a phone it had no entry of its own at all",
]);
const ok = (name, cond, detail) => {
  if (RETIRED_WITH_V1.has(name)) { retired++; return; }
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
  /* Since Signal V2 (2026-10-01) the V1 routes are in the same position:
   * they exist so an old bookmark lands on a retired notice, and nothing in
   * the site should send a reader there. */
  const ALIAS = new Set(["/404", "/buoy", "/signals", "/engines", "/research", "/ideas"]);
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
  /* Old addresses answered by the Worker's 301 (MOVED) are not pages. */
  const moved = new Set([...(IDX.match(/const MOVED = \{([\s\S]*?)\};/) || ["", ""])[1].matchAll(/"(\/[a-z]+)":/g)].map((m) => m[1]));
  const missing = [...routes].filter((r) => !dynamic(r) && r !== "/404" && !pages.has(r) && !moved.has(r));
  const extra = [...pages].filter((p) => p !== "/gems" && p !== "/vision" && !routes.has(p));
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
  // Feeds the private engine writes to trading-dashboard/feeds/ (not docs/)
  // are mirrored by their own named step, each with its schema check.
  const fromFeedsDir = (f) => SYNC.includes(`f=${f}.json`);
  const unmirrored = [...fetched].filter(
    (f) => !LIVE.has(f) && !feeds.has(f) && !builtHere(f) && !fromFeedsDir(f));
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
   * lite cache. The five are the screen, the company page, the engine floor,
   * the regime panel and /vetted (its case for and against is the one field
   * the lite table drops); adding a sixth means moving this number, on
   * purpose, in the same commit. */
  const fullGuards = (code.match(/!SCREEN \|\| SCREEN_LITE/g) || []).length;
  ok("every full-payload call site rejects a lite cache", fullGuards === 5, fullGuards);
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
  /* 4 since Signal V2: the old front page, ideas and brief no longer load the
     screen; Market (radar/heat/map) and the watchlist still do. */
  ok("every light route goes through it", liteN >= 4, liteN);
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
  /* SIGNAL V2: Today | Setups | Watchlist | Record | Market on a desktop;
     Today | Setups | Watchlist | Record | More on a phone. One name per page
     on both (2 Oct 2026): the desktop said Opportunities and Performance
     while the phone said Setups and Record. The paths did not change. */
  const nav = [...HTML.matchAll(/<a href="(\/[a-z/]*)" data-route="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/g)]
    .map((m) => ({ href: m[1], route: m[2], label: m[3] }));
  /* FIVE, FROM 2026-10. The redesign made each slot one READER GOAL — Today,
     Brief, Screen, Ledger, Markets — and moved the personal utility (Watch)
     and the tool index (Discover) out of the bar into the header's utilities
     and the More sheet. Both are still one tap away; neither is a peer of the
     ledger. Exact, not a floor, for the reason above. */
  ok("the bar has five slots", nav.length === 5, nav.map((n) => n.label));
  ok("the five are the V2 destinations, in order",
     JSON.stringify(nav.map((n) => n.route)) === JSON.stringify(["/", "/opportunities", "/watch", "/performance", "/markets"]),
     nav.map((n) => n.route));
  /* ONE LABEL PER TAB. Each tab used to carry a desktop and a phone span with
     the same word, so the accessible name read "Setups Setups". */
  ok("on a phone they read Setups and Record, once each, and Market gives its slot to More",
     /<span>Setups<\/span><\/a>/.test(HTML) && /<span>Record<\/span><\/a>/.test(HTML) && !/class="l-[dm]"/.test(HTML)
     && /class="t-desk"/.test(HTML) && /class="t-mob" data-more/.test(HTML));
  ok("the desktop names the same two pages the same way",
     nav.find((n) => n.route === "/opportunities")?.label === "Setups" && nav.find((n) => n.route === "/performance")?.label === "Record",
     nav.map((n) => n.label));
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
  /* #moreBtn CAME BACK AS A DIFFERENT THING. The old one was a sixth SLOT
     labelled "More" — a junk drawer in the navigation. The new one is a
     utility in the header, beside search, that opens a <dialog> of every tool
     and the settings. What must hold is the distinction: it is never inside
     the bar, and the sheet lists tools from DISCOVER, the same table
     /discover renders, so the two cannot drift. */
  ok("#moreBtn is a header utility, never a slot in the bar",
     !/id="moreBtn"/.test((HTML.match(/<nav class="tabs"[\s\S]*?<\/nav>/) || [""])[0])
     && /class="bar-right"[\s\S]*?id="moreBtn"/.test(HTML));
  ok("the More sheet is filled from DISCOVER", /DISCOVER\.filter\(\(\[h\]\) => !PRIMARY\.has\(h\)\)/.test(JS));
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
  /* Gems words the same field; it must say the same words, and none of the
     site's verdict words may be an instruction. */
  const GJ = readFileSync("public/gems.js", "utf8");
  const gw = (GJ.match(/const VD_WORDS = \{([^}]*)\}/) || ["", ""])[1];
  const gwords = [...gw.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok("gems words the verdict exactly as signal.js does", JSON.stringify([...gwords].sort()) === JSON.stringify([...words].sort()), { gwords, words });
  ok("no verdict word is an instruction to trade", !words.some((w) => /^(buy|sell|avoid|act|ignore)\b/i.test(w)), words);
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

  /* 4 since 2026-10-01: the retired Vision engines' grading job left the
     watchdog when the site stopped showing or linking their record. */
  /* 3 since the Signal V2 cutover: daily_scan.yml (the V1 engines) left the
     watchdog with its schedule. */
  ok("the watchdog watches something", WATCH.length === 3, WATCH.length);
  ok("the watchdog no longer dispatches the retired V1 scan", !WATCH.some((w) => w.file === "daily_scan.yml"));
  {
    /* Every sync-data cron is a watchdog slot and vice versa — a slot here
       without a cron dispatches daily with nothing to explain why. */
    const SY = readFileSync(".github/workflows/sync-data.yml", "utf8");
    const crons = [...SY.matchAll(/cron: "(\d+) (\d+) \* \* ([\d*-]+)"/g)].map((m) => `${+m[2]}:${+m[1]}`).sort();
    const slots = WATCH.find((w) => w.file === "sync-data.yml").slots.map((s) => `${s.h}:${s.m}`).sort();
    ok("sync-data's crons and the watchdog's slots are the same list", JSON.stringify(crons) === JSON.stringify(slots), { crons, slots });
  }
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
  const brief = WATCH.find((w) => w.file === "scheduled_tasks.yml");
  ok("the briefs are watched", !!brief);
  for (const sl of (brief && brief.slots) || [])
    ok(`brief ${sl.h}:00Z names the task it is dispatching`, !!(sl.inputs || {}).task, sl);

  /* ── dueSlot, THE ARITHMETIC ─────────────────────────────────────────────
   * Everything above is inventory. This is the function that decides whether
   * a missed slot is noticed, and it had never been executed by a test. */
  const utc = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi));
  // 2026-09-16 is a Wednesday.
  /* Fixed fixtures since the V1 scan left the watchdog: the arithmetic is
     the same for any weekday slot, and these keep it executed. */
  const midday = { dow: [1, 2, 3, 4, 5], h: 6, m: 0, inputs: { slot: "midday" } };
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
  const eod = { dow: [1, 2, 3, 4, 5], h: 12, m: 0, inputs: { slot: "eod" } };
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
  /* 2026-10: THE SERIF IS THE DISPLAY VOICE, AND IT HAS EXACTLY TWO DOORS.
     The redesign promoted the brief's headline face to every route title and
     the masthead, through --disp. What this still guards is the thing that
     went wrong the first time — the face spreading into body and interface
     text one rule at a time. Four names, exactly: the @font-face family, its
     file, --b-serif and --disp. --ui and --serif, which carry every label,
     paragraph and control, must never reach it. */
  ok("Newsreader is named exactly four times — family, file, --b-serif, --disp",
     refs.length === 4, refs.length);
  ok("...and two of them are --b-serif and --disp",
     /--b-serif:'Newsreader'/.test(body) && /--disp:'Newsreader'/.test(body));
  for (const t of ["--serif", "--ui"]) {
    const m = body.match(new RegExp(`${t}:([^;]+);`));
    ok(`${t} resolves to the interface face, not the serif`,
       !!m && !/Newsreader/.test(m[1]), m && m[1]);
  }
  /* AND IT IS STILL NOT PRELOADED, though every route's title now uses it.
     Measured on 2026-10-01 (390px, 4x CPU, 1.6 Mbps, median of three): the
     preload cost the front page 92 ms of LCP and removed no layout shift —
     CLS 0.001 with and without, because the headline swaps inside its own
     box. A preload is the highest-priority fetch a page can make; it has to
     buy something. */
  ok("the serif is not preloaded — measured slower, no CLS benefit",
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

/* ── THE RADAR CARD, AFTER IT WAS ACTUALLY LOOKED AT ────────────────────────
 *
 * scripts/gallery.mjs renders the shipped renderers against the shipped
 * stylesheet. Two defects that had been live were visible in the first
 * screenshot and in neither the CSS nor the JS.
 */
{
  /* 1. .rd-f WAS TWO COMPONENTS. The /reads study figures and the radar's
   *    facts cell shared a class name; the study rule is later in the sheet
   *    at equal specificity, so it won. The radar's cells computed
   *    margin:12px 0 4px, gap:6px 8px and flex-wrap:wrap from a rule written
   *    for another page — 301px of a 514px card at 430px.
   *
   *    Scoped to its own parent rather than renamed: the study's markup is a
   *    <div> inside .rd-b, the radar's a <span> inside .rd-facts. */
  ok("the study's figures are scoped to their own block",
     /\.rd-b > \.rd-f\{/.test(CSS));
  ok("...and no bare .rd-f rule can reach the radar again",
     !/(?:^|\})\s*\.rd-f\s*\{[^}]*margin:12px/m.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("the two really are different components",
     /class="rd-f"/.test(JS) && /<div class="rd-f">/.test(JS));

  /* 2. THE HIERARCHY WAS INVERTED. Measured in the browser: RSI 16px, symbol
   *    14px, price 13px — a supporting statistic set larger than the company
   *    it described, so the eye had no path through the card.
   *
   *    Checked as an ORDER, not as pixel values, so restyling the card cannot
   *    quietly put a fact back on top of its own subject. */
  {
    const STEP = {};
    for (const m of CSS.matchAll(/--t-(\d+):(\d+)px/g)) STEP["--t-" + m[1]] = Number(m[2]);
    ok("the type scale can be read", Object.keys(STEP).length >= 10, Object.keys(STEP).length);
    const sizeOf = (sel) => {
      const re = new RegExp(`\\${sel}\\{[^}]*?(?:font|font-size):[^;}]*?var\\((--t-\\d+)\\)`);
      const m = CSS.match(re);
      return m ? STEP[m[1]] : null;
    };
    const sym = sizeOf(".rd-id b"), fact = sizeOf(".rd-f b"), px = sizeOf(".rd-px");
    ok("all three sizes resolve", sym && fact && px, { sym, fact, px });
    ok("the company name is bigger than a statistic about it", sym > fact, { sym, fact });
    ok("...and the price is not the smallest of the three", px >= fact, { px, fact });
  }

  /* 3. FOUR BARS IN ONE COLOUR AND NOTHING TO READ THEM AGAINST. A reader
   *    could see Institutional was shorter than Trend and not whether either
   *    was pulling the score up or down — the only question the four are on
   *    the card to answer. The tick is the card's OWN composite, already
   *    printed two lines above; no second colour, no new computation. */
  ok("each component bar carries the composite as a reference",
     /\.rd-p i::after\{[^}]*left:var\(--at/.test(CSS.replace(/\s*\n\s*/g, "")));
  ok("...positioned from the score the card already shows",
     /--at:\$\{Math\.max\(0, Math\.min\(100, Number\(nd\.score\)/.test(JS));
  ok("...and the track no longer clips it", !/\.rd-p i\{[^}]*overflow:hidden/.test(CSS));
  /* A tick with no explanation is decoration. */
  ok("the bars say what the tick is",
     /class="rd-parts" title="[^"]*composite score/.test(JS));
}

/* ── PHASE 0 FINDINGS, PINNED (AUDIT-PHASE0.md) ───────────────────────────
 * Each of these shipped to production once. The checks keep them fixed. */
{
  const { extract } = await import("../scripts/verbatim.mjs");
  const CSSs = readFileSync("public/signal.css", "utf8");
  const HTMLs = readFileSync("public/index.html", "utf8");
  /* 1. The empty book. recordOf returned before building `bucket`, and the
        front page printed "undefined" four times until the first close. Run
        it, don't pattern-match it. */
  const code = ["isScored", "withdrawn", "tStat", "lgamma", "betacf", "betai", "tPValue", "recordOf"]
    .map((n) => extract(JS, n)).join("\n");
  const recordOf = new Function(code + "; return recordOf;")();
  const empty = recordOf([{ status: "OPEN", badge: "open" }, { status: "EXPIRED" }]);
  ok("recordOf returns buckets for a book with nothing closed",
     empty.bucket && empty.bucket.open === 1 && empty.bucket.expired === 1 && empty.bucket.closed === 0, empty.bucket);
  const some = recordOf([{ r_multiple: -1, badge: "loss" }, { status: "OPEN" }]);
  ok("...and still for a book with closes", some.bucket && some.bucket.closed === 1 && some.bucket.open === 1, some.bucket);
  ok("the Integrity block asserts its sum rather than leaving it to the reader",
     /const ok = sum === LR\.published;/.test(JS) && /These do not sum to/.test(JS));
  ok("the tile's open count is the bucket's, not a second definition", /LR\.open = LR\.bucket\.open;/.test(JS));

  /* 2. One barometer. The front page computed its own from weekly breadth. */
  ok("the front page leads with the published barometer.json",
     /const HB = BPt \?/.test(JS) && /get\('\/barometer\.json'\)/.test(JS));
  ok("weekly breadth is never labelled as today's", !/'Advancing today'/.test(JS));
  ok("wins and losses are not printed as advancing and declining", /u: 'won', f: 'still open', d: 'lost'/.test(JS));

  /* 3. The clock: IST, the session, per minute. */
  ok("no per-second clock", !/setInterval\(tickClock, 1000\)/.test(JS));
  ok("no MYT clock in the header", !/timeZone: 'Asia\/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second/.test(JS));

  /* 4. Phones: no Command key, one-line disclaimer that needs no JS, still ticker. */
  ok("the ⌘K hint is hidden on a phone, the word is not",
     /@media\(max-width:900px\)\{\.cmdk kbd\{display:none\}/.test(CSSs) && !/\.cmdk \.cmdk-l\{display:none\}/.test(CSSs));
  ok("the disclaimer collapses to one line on a phone, in static HTML",
     /<details class="dscl-m">/.test(HTMLs) && /Not registered with SEBI/.test(HTMLs.split('<details class="dscl-m">')[1] || ""));
  ok("the ticker does not scroll itself on a touch screen", /@media \(hover:none\)\{\s*\.tkr-t\{animation:none\}/.test(CSSs));
}

/* ── WHY THIS SIGNAL? ──────────────────────────────────────────────────────
 * The card printed the engine's standing rule, unlabelled, where a reader
 * looks for the reason behind one trade. The panel keeps the kinds apart. */
{
  ok("the ledger card no longer prints raw remarks as if they were this trade's reason",
     !/\$\{r\.remarks \? `<div class="card-body">/.test(JS));
  ok("measured reasons and the engine's rule are separate, labelled layers",
     /ek-r">Measured</.test(JS) && /ek-m">Rule</.test(JS) && /Describes every trade this engine files/.test(JS));
  ok("an engine that files only zeros is shown as unscored, not rated 0",
     /out\[k\] = !real\.length \? 'none'/.test(JS) && /does not score its signals/.test(JS));
  ok("the trust gate is drawn against 30 closed and t 2", /n \/ 30 \* 100/.test(JS) && /t ≥ 2/.test(JS));
  ok("the screen's reading is labelled as the screen's, not the engine's", /not from the engine that filed this/.test(JS));
}

/* ── VISION: ONE MOVE SCORE, AND NO SIGNALS ─────────────────────────────────
 * vision.askakshay.com carries a COPY of the move score so it need not load a
 * 500 KB bundle. A copy is only acceptable if it cannot drift — one name with
 * two scores on two products is the failure this repo has already had once
 * (8 engines on one page, 9 on another). So every copied definition is
 * extracted from both files and compared token for token, comments aside.
 *
 * Since 2026-09-23 Vision carries no trading signals: no ledger, no per-signal
 * reason, no record, no link to the signal site. Those are being rebuilt as
 * their own product. The checks below keep them from creeping back in through
 * a copy-paste. */
{
  const { CORE, extract, norm } = await import("../scripts/verbatim.mjs");
  const VJS = readFileSync("public/vision.js", "utf8");
  const VCSS = readFileSync("public/vision.css", "utf8");
  const VHTML = readFileSync("public/vision.html", "utf8");
  const drift = CORE.filter((n) => { const a = extract(JS, n), b = extract(VJS, n); return !a || !b || norm(a) !== norm(b); });
  ok("vision.js carries signal.js's move-score code verbatim", drift.length === 0,
     drift.length ? `${drift.join(", ")} — run \`npm run verbatim\`` : "");
  /* The check has to be able to fail. */
  const tampered = VJS.replace("if (live.length < 2) return null;", "if (live.length < 1) return null;");
  ok("...and the comparison catches a one-character change",
     tampered !== VJS && norm(extract(tampered, "radarScore")) !== norm(extract(JS, "radarScore")));

  const toks = (sel) => new Set([...((VCSS.match(new RegExp(sel + "\\{([\\s\\S]*?)\\n\\}")) || ["", ""])[1]
    .matchAll(/(--[a-z0-9-]+):/g))].map((m) => m[1]));
  /* 2026-10: LIGHT IS THE DEFAULT (:root), dark the override, as on Signal.
     The rule is unchanged in substance — neither theme may inherit a colour
     designed for the other — only the direction of the default flipped. */
  const light = toks(':root,:root\\[data-theme="light"\\]'), dark = toks('\\n:root\\[data-theme="dark"\\]');
  const missing = [...light].filter((t) => !dark.has(t));
  ok("vision.css: both themes define their colour tokens", dark.size >= 15 && light.size >= 15, { dark: dark.size, light: light.size });
  ok("...and dark redefines every one light sets", missing.length === 0, missing);
  ok("vision.css paints an explicit body background", /body\{[^}]*background:var\(--bg\)/.test(VCSS));
  ok("vision.css removes motion under prefers-reduced-motion", /prefers-reduced-motion:reduce/.test(VCSS));

  const offOrigin = [...VJS.matchAll(/(?:fetch|get)\(\s*['"`](https?:)?\/\/[^'"`]+/g)].map((m) => m[0]);
  ok("vision.js fetches only its own origin", offOrigin.length === 0, offOrigin);
  ok("vision.html keeps the SEBI disclaimer", /Not registered with SEBI/.test(VHTML));
  ok("...and links it to its own full disclaimer, not another site's", /href="#\/disclaimer"/.test(VHTML) && /V\.disclaimer = /.test(VJS));

  /* PARENT AND CHILD, ONE SPELLING EACH. Signal is the parent, Vision the
     child: Vision links back to Signal and Signal links into Vision — by
     design since the 2026-09-30 audit, reversing the earlier "no trace" rule.
     What stays pinned is that each side names the other in exactly one
     constant (plus vision.html's static header link), so a host move is one
     edit, and Vision still reads nothing of the ledger (checks below). */
  const all = VJS + VCSS + VHTML;
  const sigRefs = (VJS.match(/https:\/\/signal\.askakshay\.com/g) || []).length;
  ok("vision.js names Signal only in SIGNAL_URL", sigRefs === 1 && /const SIGNAL_URL = 'https:\/\/signal\.askakshay\.com';/.test(VJS), sigRefs);
  ok("vision.html links back to Signal in its header", /class="up-link" href="https:\/\/signal\.askakshay\.com\/"/.test(VHTML));
  ok("vision names no gems site", !/gems\.askakshay\.com/.test(all));
  ok("signal.js names Vision only in VISION_URL (and the shell's bar link)",
     (JS.match(/https:\/\/vision\.askakshay\.com/g) || []).length === 1 && /const VISION_URL = 'https:\/\/vision\.askakshay\.com';/.test(JS));
  ok("every stock link on Signal offers Vision", /const symLinks = [\s\S]{0,200}visionUrl\(sym\)/.test(JS));

  /* THE EDGE LAYER — each route its own head, written before JavaScript. */
  const SEO = readFileSync("src/seo.js", "utf8"), IDX2 = readFileSync("src/index.js", "utf8");
  const KEY_RE = /replace\(\/\[\^A-Z0-9-\]\/g, ["']_["']\)/;
  ok("one file-key rule in the Worker, the builder, Vision and Signal",
     [SEO, readFileSync("scripts/company-pages.mjs", "utf8"), VJS, JS].every((t) => KEY_RE.test(t)));
  ok("the Worker renders Signal's page routes and Vision's home and company pages",
     /signalPage\(request, env, p\)/.test(IDX2) && /visionHome\(request, env\)/.test(IDX2) && /visionCompany\(request, env, cm\[1\]\)/.test(IDX2));
  {
    const { execFileSync } = await import("node:child_process");
    let fresh = true; try { execFileSync("node", ["scripts/route-meta.mjs", "--check"], { stdio: "pipe" }); } catch { fresh = false; }
    ok("src/route-meta.js matches signal.js's META", fresh);
    const pagesLit = (IDX2.match(/const PAGES = new Set\(\[([\s\S]*?)\]\)/) || ["", ""])[1];
    const pages = [...pagesLit.matchAll(/"(\/[a-z]*)"/g)].map((m) => m[1]).filter((x) => !["/gems", "/vision"].includes(x));
    const { SIGNAL_META } = await import(new URL("../src/route-meta.js", import.meta.url));
    const noMeta = pages.filter((x) => !SIGNAL_META[x]);
    ok("every page route has its own title — none falls back to the front page's", noMeta.length === 0 && pages.length > 20, noMeta);
  }
  ok("vision.html loads insight.js before vision.js", VHTML.indexOf('src="/insight.js"') > 0 && VHTML.indexOf('src="/insight.js"') < VHTML.indexOf('src="/vision.js"'));
  ok("the Worker runs the same insight.js the browser does", /import "\.\.\/public\/insight\.js"/.test(SEO));
  {
    /* insight.js itself: missing is silent, never zero; thresholds hold. */
    await import(new URL("../public/insight.js", import.meta.url));
    const I = globalThis.VisionInsight;
    const bare = I.changes({ sym: "X" }, null, {});
    ok("insight: an empty row yields no claims", Object.values(bare).every((l) => l.length === 0));
    const m0 = I.matters({ sym: "X" }, null, {});
    ok("insight: an empty row yields no 'what matters' tiles (no zero-fill)", m0.length === 0);
    const c = I.changes({ sym: "X", rev_yoy: 20, rev_cagr: 10, roce: 10, roce_med: 11, de: -0.4 }, null, {});
    ok("insight: 10 pp revenue acceleration is reported, 1 pp ROCE gap is not",
       c.improved.some((i) => /Revenue growth accelerated/.test(i.t)) && !c.weakened.some((i) => /Returns on capital/.test(i.t)));
    ok("insight: negative D/E is named negative equity", c.watch.some((i) => /Negative equity/.test(i.t)));
    ok("insight: every claim carries a basis and a source", [...c.improved, ...c.watch].every((i) => i.basis && i.src));
    ok("insight: no recommendation language", !/\b(buy|sell|accumulate|target price|should)\b/i.test(readFileSync("public/insight.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
    /* THE UPGRADE: one-minute read, questions, why-it-matters, ordinals. */
    const om0 = I.oneMinute({ sym: "X" }, null, {});
    ok("insight: an empty row gets no one-minute read and no event", om0.reads.length === 0 && om0.event === null);
    ok("insight: an empty row raises no question", I.questions({ sym: "X" }, null, {}).length === 0);
    const qs = I.questions({ sym: "X", rev_yoy: -5, rev_cagr: 10, roce: 10, roce_med: 18, cfo_pat: 0.3, de: 2, pe_pctile: 10, r1m: -12,
      next_earnings: "2026-10-10" }, { quality: "complete", insti_pp: 1, fii_pp: 0.6, dii_pp: 0.4, period: "Q1" }, { median_1m: -2, today: "2026-10-04" });
    ok("insight: questions stop at four, each with the fact behind it", qs.length === 4 && qs.every((q) => q.q.endsWith("?") && q.basis));
    ok("insight: the valuation question names both of its causes",
       I.questions({ sym: "X", pe_pctile: 10, r1m: -12 }, null, { median_1m: -2 }).some((q) => /price weakness or by the fundamentals/.test(q.q)));
    ok("insight: a lender gets no cash-conversion or debt question",
       !I.questions({ sym: "B", sector: "Financial Services", cfo_pat: 0.2, de: 6 }, null, {}).length);
    ok("insight: every What-matters key has a Why-it-matters line",
       ["Revenue", "ROCE", "ROE", "EBIT margin", "Debt / equity", "Cash conversion", "Price, 1 month", "Valuation", "Institutions"].every((k) => I.WHY[k]));
    ok("insight: 81st, 92nd, 11th — never 81th", [81, 92, 11, 3, 113].map(I.ord).join() === "81st,92nd,11th,3rd,113th");
    ok("no page prints a percentile as Math.round(x) + 'th'",
       ![JS, VJS, readFileSync("public/insight.js", "utf8")].some((src) => /Math\.round\([^)]*\)\s*\+\s*'th|Math\.round\([^)]*\)\}th/.test(src)));
  }
  {
    /* LENDERS: the screen's own rule (stock_screen.py::_is_financial). It takes
       leverage, cash conversion, margins and ROCE out of a lender's scores and
       risk grade; the pages judged them anyway, so EDELWEISS read "Risk LOW"
       beside a red "heavily geared" and a green 7.64x cash conversion. Every
       copy must be the Python's four words, no more, no fewer. */
    const I = globalThis.VisionInsight;
    const RULE = "financial|bank|insurance|real estate";
    const rules = (src) => [...src.matchAll(/\/((?:[a-z ]+\|){3}[a-z ]+)\/\.test\(/g)].map((m) => m[1]);
    for (const [f, src] of [["public/insight.js", readFileSync("public/insight.js", "utf8")], ["public/signal.js", JS], ["public/vision.js", VJS]]) {
      const rs = rules(src);
      ok(`${f} reads lenders with the screen's four words`, rs.length > 0 && rs.every((x) => x === RULE), rs);
    }
    const edel = { sym: "EDELWEISS", sector: "Financial Services", ind: "Financial Services", de: 4.02, cfo_pat: 7.64, roe: 11.8, roe_med: 8.9, margin_delta: 5, roce: 3, roce_med: 9 };
    const mt = I.matters(edel, null, {}), ch = I.changes(edel, null, {});
    ok("insight: a lender's D/E is not called geared or coloured as a risk",
       mt.some((t) => /Debt/.test(t.k || t.label || JSON.stringify(t))) && !JSON.stringify(mt).match(/heavily geared|lightly geared/) && !ch.watch.some((i) => /High leverage/.test(i.t)));
    ok("insight: a lender's cash conversion and ROCE are not judged", !JSON.stringify(mt).match(/Cash conversion|EBIT margin/) && !JSON.stringify(ch).match(/Returns on capital|Margins|not turning into cash/));
    ok("insight: a lender with negative equity is still named", I.changes({ ...edel, de: -1 }, null, {}).watch.some((i) => /Negative equity/.test(i.t)));
    const ind = { sym: "X", sector: "Industrials", de: 2.4, cfo_pat: 0.4 };
    ok("insight: an industrial is still judged on leverage and cash", I.changes(ind, null, {}).watch.some((i) => /High leverage/.test(i.t)) && I.changes(ind, null, {}).watch.some((i) => /not turning into cash/.test(i.t)));
    /* A LEVEL IS NOT A CHANGE: yoy() prints "+" and a direction colour. */
    ok("signal's stock card prints level ratios as levels, not signed changes", !/yoy\('(Cash conversion|Free cash|ROCE|Debt \/ equity)/.test(JS));
    /* The company header's range label reads the same price as its marker. */
    ok("vision's range label is computed from the displayed price", /fh = px > 0 && hi52 > 0 \? \(px \/ hi52 - 1\) \* 100/.test(VJS) && !/r\.from_high != null \? signed\(r\.from_high, 1\) \+ ' from the high'/.test(VJS));
  }
  ok("vision has a company-search home and a compare view", /V\.home = /.test(VJS) && /V\.compare = /.test(VJS));
  ok("vision's company page charts ownership by quarter, in colours set for both themes",
     /function ownChart\(series, width\)/.test(VJS) && /ownChart\(x\.series/.test(VJS)
     && /:root,:root\[data-theme="dark"\]\{ --viz-1:/.test(VCSS) && /:root\[data-theme="light"\]\{ --viz-1:/.test(VCSS));
  ok("the privacy page names the analytics the host runs, not 'no analytics script'",
     /Cloudflare Web Analytics/.test(JS) && !/There is no analytics script/.test(JS));
  {
    /* The front page's heavy feeds start with the route, not after its first
       wave — after meant a guaranteed second full repaint (measured 6.8s to a
       complete page against 5.6s), and a count that changed under the reader. */
    const home = JS.slice(JS.indexOf("R['/'] = async"), JS.indexOf("R['/'] = async") + 20000);
    const start = home.indexOf("if (!heavyTried) {"), wave = home.indexOf("await Promise.all(");
    ok("the front page requests its heavy feeds before awaiting the first wave", start > 0 && wave > 0 && start < wave, { start, wave });
  }
  ok("the ledger offers a Closed filter", /\['closed', `Closed \$\{closedN\}`\]/.test(JS) && /sigFilter === 'closed'/.test(JS));
  ok("vision reads no ledger", !/\/api\/signals\?(limit|symbol)|alerts\.json|\/api\/stats/.test(VJS));
  ok("vision loads no engine registry", !/engines\.js|ENGINE_BOOK/.test(all));
  ok("vision has no signal or record route", !/V\.(signals|record) = |['"]#\/(signals|record)['"]/.test(VJS));
  /* Vision's Signals page shows two setups computed upstream (scanner.py's
     vision_bottom_reversal and vision_4h_breakout) and nothing else: it is not
     the ledger, so it must not be routed as #/signals, and it must read ONE
     feed that both mirrors actually carry — a feed fetched but never synced
     does not fail, it freezes. */
  const SYNC_V = readFileSync(".github/workflows/sync-data.yml", "utf8");
  const PULL_V = readFileSync("scripts/pull-feeds.mjs", "utf8");
  /* Since 2026-10-01 Setups renders the end-of-day plans (/vision_eod.json,
     from a PRIVATE engine) and keeps the retired engines as an archive
     (/vision_signals.json). Both feeds must be mirrored by both paths. */
  /* SIGNAL V2: Vision consumes the SAME canonical plan feed Signal reads. */
  ok("vision's setups read the canonical V2 plan feed",
     /V\.setups = /.test(VJS) && /get\('\/signal_v2\.json'/.test(VJS));
  ok("the V2 feed is mirrored by the scheduled sync and the deploy, schema-checked",
     /contents\/feeds\/\$f"/.test(SYNC_V) && /f=signal_v2\.json/.test(SYNC_V)
     && /signal-v2-public\/1/.test(SYNC_V) && /signal_v2\.json/.test(PULL_V) && /signal-v2-public\/1/.test(PULL_V));
  /* PRIVATE LOGIC. The engine's rules run server-side; the browser gets an
     allowlisted projection. This file is checked for the shape of a leak —
     indicator names, thresholds, a score or rank, a probability — anywhere in
     the code that renders the plans (comments stripped). */
  const VE_SRC = (VJS.match(/\/\* ── SETUPS: THE SIGNAL V2 PLAN[\s\S]*?\n  V\.disclaimer = /) || [""])[0].replace(/\/\*[\s\S]*?\*\//g, "");
  const VE_CODE = VE_SRC;
  ok("no Vision EOD selection logic ships to the browser",
     VE_CODE.length > 2000 && !/\b(EMA|SMA|ATR|RSI|MACD)\d*\b|\bRS63\b|pullback_|touch_band|depth_atr|\.score\b|\.rank\b|\.features?\b|probability of|win rate of/i.test(VE_CODE.replace(/Not a probability/g, "")),
     (VE_CODE.match(/\b(EMA|SMA|ATR|RSI)\d*\b|\.score\b|\.rank\b|\.features?\b/gi) || []).slice(0, 5));
  /* The public allowlist, mirrored from vision-engine/vision_eod/publish.py.
     The deployed feed (pulled at deploy) is held to it key by key; a key the
     engine adds without adding it here fails the deploy, not the reader. */
  const VE_KEYS = {
    top: ["schema", "product", "model_version", "mode", "status", "status_detail", "session_date", "published_at", "data_as_of", "coverage",
      "next_session", "next_scan_due", "calendar_verified", "cutover_at", "forward_record_start", "strategies", "exit_plan",
      "entry_expiry_sessions", "time_exit_sessions", "reference_size", "costs", "plans", "metrics", "fills_are", "notice", "history",
      "paper"],
    paper: ["basis", "as_of", "engines", "plans", "intraday", "retired", "min_closed_for_avg"],
    paperEngine: ["id", "name", "module", "kind", "what", "since", "last_session", "filed", "open", "closed", "wins", "losses", "avg_r"],
    paperPlan: ["id", "engine", "symbol", "filed_session", "for_session", "valid_through", "entry_low", "entry_high", "stop", "t1", "t2",
      "t3", "sell_pct", "qty", "state", "fill_price", "fill_session", "exits", "total_r", "why", "trailing", "risk_pct", "tranches", "initial_stop", "ended_session", "rules", "grading_gap"],
    paperIntra: ["id", "engine", "symbol", "session", "decided_at", "entry", "stop", "t1", "t2", "t3", "qty", "exits", "total_r"],
    history: ["basis", "benchmark", "exposed", "sessions", "drawdown", "nav_change_pct", "benchmark_change_pct"],
    session: ["session", "status", "published", "filled", "closed", "wins", "losses", "breakevens", "nav_inr", "nav_index",
      "benchmark_close", "benchmark_index"],
    drawdown: ["max_pct", "max_session", "current_pct", "peak_session", "sessions_since_peak"],
    plan: ["id", "strategy_id", "setup", "symbol", "name", "exchange", "currency", "direction", "session_date", "published_at", "state",
      "outcome", "entry_low", "entry_high", "stop", "initial_stop", "stop_rule", "management", "t1", "t2", "t3", "rr_t1", "rr_t2", "rr_t3",
      "valid_through", "qty", "risk_per_share", "risk_pct", "flags", "fill", "exits", "remaining_qty", "remaining_pct", "realized_r",
      "unrealized_r", "total_r", "net_pnl_inr", "open_mark_inr", "charges_inr", "last_close", "last_session", "closed_session", "updates"],
  };
  let veFeed = null;
  try { veFeed = JSON.parse(readFileSync("public/signal_v2.json", "utf8")); } catch { /* not pulled yet: a state */ }
  const veBad = !veFeed ? [] : [...Object.keys(veFeed).filter((k) => !VE_KEYS.top.includes(k)),
    ...(veFeed.plans || []).flatMap((p) => Object.keys(p).filter((k) => !VE_KEYS.plan.includes(k))),
    ...Object.keys(veFeed.history || {}).filter((k) => !VE_KEYS.history.includes(k)).map((k) => "history." + k),
    ...((veFeed.history || {}).sessions || []).flatMap((r) => Object.keys(r).filter((k) => !VE_KEYS.session.includes(k))),
    ...Object.keys((veFeed.history || {}).drawdown || {}).filter((k) => !VE_KEYS.drawdown.includes(k)).map((k) => "drawdown." + k),
    ...Object.keys(veFeed.paper || {}).filter((k) => !VE_KEYS.paper.includes(k)).map((k) => "paper." + k),
    ...((veFeed.paper || {}).engines || []).flatMap((e) => Object.keys(e).filter((k) => !VE_KEYS.paperEngine.includes(k)).map((k) => "paper.engine." + k)),
    ...((veFeed.paper || {}).plans || []).flatMap((e) => Object.keys(e).filter((k) => !VE_KEYS.paperPlan.includes(k)).map((k) => "paper.plan." + k)),
    ...((veFeed.paper || {}).intraday || []).flatMap((e) => Object.keys(e).filter((k) => !VE_KEYS.paperIntra.includes(k)).map((k) => "paper.intraday." + k))];
  ok("the published V2 feed carries only allow-listed keys", veBad.length === 0, veBad.slice(0, 5));
  /* Five distinct scan states, never blurred into one another. */
  ok("setups distinguish no-setup, market filter, data unavailable, stale and error",
     /D\.status === 'error'/.test(VJS) && /veStale\(D\)/.test(VJS) && /D\.status === 'data_unavailable'/.test(VJS)
     && /D\.status === 'market_filter'/.test(VJS) && /thresholds are not lowered to fill this page/.test(VJS));
  /* A plan is not a trade: awaiting, expired and cancelled are never results,
     fills are labelled simulated, and no average prints before 30 complete. */
  ok("a published plan is never counted as a result, and fills say simulated",
     /const VE_DONE = new Set\(\['closed', 'stopped', 'time_exited'\]\)/.test(VJS) && /simulated<\/span>/.test(VJS)
     && /const VE_NEED = 30;/.test(VJS) && /Never filled/.test(VJS));
  /* Owner decision 2026-10-01: the retired engines (bottom reversal, 4H
     breakout) are not shown or linked ANYWHERE on this site. Their record is
     kept upstream only. Nothing may fetch, mirror, render or ship it. */
  ok("the retired engines are not shown, linked, mirrored or shipped",
     !/vision_signals|Legacy archive|ve-arch|VS_WORD|F\.vsig/.test(VJS + readFileSync("public/vision.css", "utf8"))
     && !/vision_signals/.test(SYNC_V + PULL_V + readFileSync("scripts/company-pages.mjs", "utf8") + SEO)
     && !existsSync("public/vision_signals.json") && !/vision_scan/.test(readFileSync("src/watchdog_schedule.js", "utf8")));
  /* Deploy 220: the Worker 404s a missing feed with "no such file: …" and the
     page matched the error TEXT for "HTTP 404", so the pre-scan state read
     "failed". Executed against what the Worker and get() actually produce. */
  const absSrc = (VJS.match(/const absent = (\(r\) => [^\n]+);/) || [])[1];
  const absent = absSrc ? new Function(`return ${absSrc}`)() : null;
  const workerMiss = /error: `no such file: \$\{p\}` \},\s*\{ status: 404 \}/.test(IDX);
  ok("a feed the Worker 404s reads as not published, not failed",
     !!absent && workerMiss && /status: r\.status, error: \(data && data\.error\)/.test(VJS)
     && absent({ ok: false, status: 404, error: "no such file: /vision_signals.json" })
     && absent({ ok: false, status: 200, error: "/vision_signals.json is not JSON (HTTP 200)" })
     && !absent({ ok: false, status: 502, error: "/vision_signals.json is not JSON (HTTP 502)" })
     && !absent({ ok: false, error: "timed out after 15s" }) && !absent({ ok: true, data: {} })
     && !/not JSON\|HTTP 404/.test(VJS), absSrc);
  /* The heatmap was coloured from the screen build and never redrawn, so it
     showed a session days old and did not move. Both maps draw live rows and
     their views hand the minute beat a function that re-quotes and redraws. */
  const HEATV = (VJS.match(/V\.heatmap = [\s\S]*?\n  \};/) || [""])[0];
  ok("the heatmap is live: live rows, re-quoted on the minute beat",
     /treemap\(host, rows\.map\(liveRow\)/.test(HEATV) && /await heatQuotes\(\+o\.n, o\.size\)/.test(HEATV) && /\n    return live;\n  \};$/.test(HEATV)
     && /treemap\(host, Object\.values\(SCR\)\.map\(liveRow\)/.test(VJS) && /await liveHeat\(\); await paintWatch\(\)/.test(VJS));
  /* "Top 150" and "Top 300" drew the same ~149 tiles on a phone: the count was
     capped to fit the box. Now nothing caps it; the map grows taller. */
  ok("the heatmap draws every name asked for: no count cap, height grows",
     !/const cap = /.test(VJS) && /\.slice\(0, opts\.n\)/.test(VJS) && /heatHeight\(nEff, host\.clientWidth/.test(HEATV)
     && /\[1000, 'All'\]/.test(HEATV));
  /* 1,000 live tiles through ?px= would be 50 Yahoo calls a minute PER TAB.
     The heatmap reads /api/heat: shards of 200, edge-cached, shared by all —
     and each shard must stay inside the free plan's 50 subrequests. */
  const HEATJS = readFileSync("src/api/heat.js", "utf8");
  ok("heatmap quotes are sharded, edge-cached and inside the subrequest budget",
     /F\.heat = async/.test(VJS) && /get\(`\/api\/heat\?part=/.test(VJS) && !/heatQuotes[\s\S]{0,200}F\.quotes/.test(VJS)
     && /HEAT_PART = 200/.test(HEATJS) && 200 / 20 <= 40 && /caches\.default/.test(HEATJS) && /quoteSpark/.test(HEATJS)
     && !/retryMissing/.test(HEATJS) && /url\.pathname === "\/api\/heat"\) return heat\(/.test(IDX));
  /* Vision renders ONE engine's output: the end-of-day plans. A second
     engine arriving by copy-paste is the drift this pins. */
  ok("vision renders exactly one plan feed: the canonical V2 feed",
     (VJS.match(/get\('\/[a-z_]+_(?:eod|signals|v2)\.json'/g) || []).join() === "get('/signal_v2.json'");
  /* Today is the morning read folded in from gems: a column that ends, built
     from the same live quotes as the cockpit rather than a second model. */
  const TODAY = (VJS.match(/V\.today = [\s\S]*?\n  \};/) || [""])[0];
  ok("vision's Today brief reads the live feeds and ends",
     /\['today', 'Today', '#\/today'\]/.test(VJS) && /await F\.heat\(\)/.test(TODAY) && /class="end">That is the day/.test(TODAY)
     && /no headline names it/.test(TODAY) && !/(?<!never a )win rate[^'"`]*\$\{/i.test(TODAY));
  ok("vision's setups print no win rate or expectancy",
     !/win rate[^'"`]*\$\{|expectancy[^'"`]*\$\{/i.test((VJS.match(/V\.setups = [\s\S]*?\n  \};/) || [""])[0]));

  /* FII + DII net: flows.js adds a missing side as zero. */
  ok("vision sums FII and DII only when both sides answered", /const both = f && f\.fii && f\.dii/.test(VJS));
  /* A per-second clock is battery and layout work for no information. */
  ok("vision's market clock repaints per minute, not per second", /setInterval\(paintMarket, 60000\)/.test(VJS) && !/setInterval\([^,]+, 1000\)/.test(VJS));
  ok("the Worker routes the vision host to its shell", /host\.startsWith\("vision\."\)/.test(IDX));
}

/* NO FIGURE COUNTS UP. The count-up printed "Published -18,139" (negative frame
   progress) and then "Published 0" (a reader whose frames stop keeps the first
   one). A figure is printed once, exactly; nothing animates it. */
ok("no figure counts up", !/countUp/.test(JS));

/* EVERY DEPLOY BUILDS THE COMPANY FILES. public/c/ is generated and gitignored,
   so a workflow that runs `wrangler deploy` without scripts/company-pages.mjs
   first ships a site with no company files: sync-data.yml and institutional.yml
   both did, and every Vision company page 404'd after each data sync. */
{
  const wfDir = ".github/workflows";
  const bad = [];
  let deploys = 0;
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const y = readFileSync(`${wfDir}/${f}`, "utf8");
    for (const m of y.matchAll(/^[ \t]*npx wrangler deploy/gm)) {   // executed lines, not comments
      deploys++;
      const before = y.slice(0, m.index);
      if (!/node scripts\/company-pages\.mjs/.test(before.slice(before.lastIndexOf("run:")))) bad.push(f);
    }
    if (/npm run deploy/.test(y)) deploys++;
  }
  ok("every workflow that deploys builds the company files first", deploys >= 3 && bad.length === 0, { deploys, bad });
  ok("npm run deploy builds them too", /company-pages\.mjs[\s\S]*wrangler deploy/.test(readFileSync("package.json", "utf8")));
}

/* ── 2026-10-01: THE RECORD AS TRADES, THE VISIT, THE BELL, THE INSTALL ────── */
{
  const VJS2 = readFileSync("public/vision.js", "utf8");
  const VSW = readFileSync("public/vision-sw.js", "utf8");
  const VH = readFileSync("public/vision.html", "utf8");
  ok("the front page lists recent closes from the ledger, losses included",
     /<b>Recent closes<\/b>/.test(JS) && /LRclosed\.slice\(0, 5\)/.test(JS));
  ok("toward a verdict draws each engine against the 30-trade rule",
     /<b>Toward a verdict<\/b>/.test(JS) && /const need = 30/.test(JS));
  ok("the trailing-window chip says when nothing closed, never a zero",
     /no closes yet/.test(JS) && /const LR30 = windowOf\(LRclosed, 30\)/.test(JS));
  ok("an expired or time-stopped close says its R was marked, not realised",
     /EXPIRED: 'expired, marked at the close'/.test(JS) && /TIME_STOP: 'time stop, marked at the close'/.test(JS));
  ok("since-your-last-visit lives in the browser on both sites",
     /const VKEY = 'sig:visit'/.test(JS) && /sessionStorage/.test(JS) && /const VISIT = 'vis:visit'/.test(VJS2));
  ok("the bell counts alerts fired since the watchlist was last opened",
     /id="bellBtn"/.test(HTML) && /lsSet\(FSEEN, Date\.now\(\)\); paintBell\(\);/.test(JS));
  ok("vision is installable: manifest, touch icon, its own worker",
     /rel="manifest" href="\/vision\.webmanifest"/.test(VH) && /rel="apple-touch-icon"/.test(VH)
     && existsSync("public/vision.webmanifest") && existsSync("public/vision-icon-512.png"));
  ok("vision's worker registers on the vision host only",
     /\/\^vision\\\.\/\.test\(location\.hostname\)/.test(VJS2) && /register\('\/vision-sw\.js'\)/.test(VJS2));
  ok("no worker ever caches a price, a feed or a company file",
     /url\.pathname\.endsWith\("\.json"\)\) return;/.test(VSW)
     && /url\.pathname\.endsWith\("\.json"\)\) return;/.test(readFileSync("public/sw.js", "utf8")));
}

/* ── SIGNAL V2 (2026-10-01) ───────────────────────────────────────────────────
 * One canonical plan feed, every view. A V2 view prints the feed's own levels,
 * R:R and metrics; it never computes a level, a count or a rate itself. The V1
 * engines, feeds and ledger are retired from the public site, old URLs land on
 * a plain retired notice, and nothing V1 can reach a V2 figure. */
{
  const V2B = (JS.match(/\/\* ══ SIGNAL V2 ═+[\s\S]*?\n  \/\/ The phone tab bar's "More"/) || [""])[0];
  const V2C = V2B.replace(/\/\*[\s\S]*?\*\//g, "");
  ok("the V2 block exists and reads one feed", V2B.length > 5000 && /const V2_URL = '\/signal_v2\.json'/.test(V2B)
     && (V2C.match(/get\('\/[a-z_0-9-]+\.json'\)/g) || []).every((x) => /regime|signal_v2|pulse|technical_read|paper_record/.test(x)));
  /* paper_record.json is every FINISHED paper setup, kept for good: the replay
     on its setup page and the list on the Record page. Paper, never a figure
     in the record. */
  /* technical_read.json is the Technical Confluence READ of each stock, shown
     on the stock page only; it is never a plan and never a figure in the record. */
  /* pulse.json is MARKET data for the market cards, never a source of plan
     figures; those still come from signal_v2.json alone. */
  for (const r of ["/", "/opportunities", "/performance", "/plan/:id", "/brief"])
    ok(`V2 route ${r} is rendered by the V2 block`, new RegExp(`R\\['${r.replace(/[/:]/g, (c) => "\\" + c)}'\\] = async`).test(V2B));
  /* FRESH START (owner decision 2026-10-02). Addresses from before 1 Oct 2026
     forward to the page that replaced them — a 301 at the Worker, and the
     same move in the router — and no page names a version or a retired
     engine. The record states when it began; it does not narrate the past. */
  const IDXM = (IDX.match(/const MOVED = \{([\s\S]*?)\};/) || ["", ""])[1];
  for (const [r, to] of [["/signals", "/performance"], ["/engines", "/opportunities"], ["/research", "/opportunities"], ["/buoy", "/opportunities"], ["/ideas", "/opportunities"]])
    ok(`old address ${r} forwards to ${to}`, IDXM.includes(`"${r}": "${to}"`) && /Response\.redirect\(new URL\(MOVED\[mp\], request\.url\)\.toString\(\), 301\)/.test(IDX)
       && new RegExp(`R\\['${r.replace(/\//g, "\\/")}'\\] = moved\\('${to.replace(/\//g, "\\/")}'\\)`).test(V2B));
  {
    /* Code only: comments stripped (line comments too, wherever they sit),
       and index.html left out — its pre-rendered block is the feed's own text,
       held to the same words by the engine, not by this file. */
    const strip = (f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const SEEN = ["public/signal.js", "public/vision.js", "public/v2widgets.js", "src/seo.js", "src/route-meta.js",
      "scripts/prerender.mjs", "scripts/company-pages.mjs"].map((f) => [f, strip(f)]);
    const bad = SEEN.flatMap(([f, t]) => (t.match(/Signal V[12]\b|\bV[12] (?:plan|record|forward|paper|trade)|retired V1|Signal V1|[Pp]revious model results|has been retired|belonged to Signal/g) || []).map((m) => f + ": " + m));
    ok("no page names a version or narrates the retired engines", bad.length === 0, bad.slice(0, 6));
  }
  ok("every R:R printed is the feed's own field", /p\['rr_' \+ k\]/.test(V2C) && !/\(p\.t[123] - p\.entry_high\) \/ \(p\.entry_high - p\.(?:initial_)?stop\)/.test(V2C));
  /* PAPER TEST + TECHNICAL READ (owner decision 2026-10-02). Four engines run
     forward on paper and are shown on both sites; a stock's five-part read is
     shown on both stock pages. Both are printed from upstream fields, labelled
     as what they are, and kept out of the record. */
  {
    const W2 = readFileSync("public/v2widgets.js", "utf8");
    const PAPER_FN = (W2.match(/function paper\(d, opts = \{\}\) \{[\s\S]*?\n  \}\n/) || [""])[0];
    const READ_FN = (W2.match(/function read\(feed, sym, opts = \{\}\) \{[\s\S]*?\n  \}\n/) || [""])[0];
    ok("the paper board is labelled paper and says it is not the record",
       PAPER_FN.length > 1500 && /v2w-tag pp">paper</.test(PAPER_FN) && /not the published record/.test(PAPER_FN)
       && /has not published yet/.test(PAPER_FN) && /avg after \$\{need\} closed/.test(PAPER_FN));
    ok("the paper board and the read compute no signal: no threshold in the browser",
       READ_FN.length > 1500 && !/(?:rsi|score|ext|rr|vol_ratio)\s*[<>]=?\s*\d/.test(READ_FN + PAPER_FN)
       && !/\(p\.entry_high - p\.stop\)/.test(PAPER_FN) && /rules, not a forecast/.test(READ_FN) && /not a probability|Not advice/.test(READ_FN));
    ok("the analyst counts paper setups from the engines' own fields",
       /PP\.engines\.reduce\(\(a, e\) => a \+ \(e\.open \|\| 0\)/.test(W2) && /not counted in the record/.test(W2));
    ok("both sites show the paper board and the read",
       /v2Paper\(d, \{ cardHref: setupHref(, flat: true)? \}\)/.test(V2B) && /v2Paper\(d, \{ compact: true/.test(V2B) && /sec\('Technical read', treadBlock\(r\.sym\)/.test(JS)
       && /window\.V2W\.paper\(D, \{ stockHref/.test(readFileSync("public/vision.js", "utf8"))
       && /window\.V2W\.read\(ok \? tr\.data : null, s/.test(readFileSync("public/vision.js", "utf8")));
    const SYNC_T = readFileSync(".github/workflows/sync-data.yml", "utf8"), PULL_T = readFileSync("scripts/pull-feeds.mjs", "utf8");
    ok("the technical reads are mirrored, schema-checked, in both feed paths",
       /f=technical_read\.json/.test(SYNC_T) && /technical-read\/1/.test(SYNC_T) && /technical_read/.test(PULL_T) && /technical-read\/1/.test(PULL_T));
    ok("the paper record is mirrored, schema-checked, in both feed paths",
       /f=paper_record\.json/.test(SYNC_T) && /paper-record\/1/.test(SYNC_T) && /paper_record/.test(PULL_T) && /paper-record\/1/.test(PULL_T));
    /* The replay prints the engine's own result and computes no rate: the only
       arithmetic is an exit price less the fill, for the shares sold there. */
    const REPLAY_FN = (W2.match(/function replay\(t, rec, opts = \{\}\) \{[\s\S]*?\n  \}\n/) || [""])[0];
    const FIN_FN = (W2.match(/function finished\(rec, opts = \{\}\) \{[\s\S]*?\n  \}\n/) || [""])[0];
    ok("the replay is labelled paper, prints the engine's net R and says no order was placed",
       REPLAY_FN.length > 2000 && /v2w-tag pp">paper</.test(REPLAY_FN) && /rR\(t\.total_r\)/.test(REPLAY_FN)
       && /no order was placed/.test(REPLAY_FN) && /not an order of events/.test(REPLAY_FN) && /stop was booked first/.test(W2));
    ok("an unfilled setup has no result in the replay, never a zero",
       /Nothing was bought, so there is no gain or loss/.test(REPLAY_FN) && /no fill/.test(FIN_FN));
    ok("the finished list counts from the record's own counts and computes no average",
       /c\.finished/.test(FIN_FN) && !/reduce\(|\/ T\.length|avg/.test(FIN_FN));
    ok("the NSE holiday table loads at boot on every route, not only where a page asked",
       /CALENDAR = get\('\/api\/calendar'\)/.test(JS) && /CALENDAR\.then\(r => \{\s*if \(r && r\.ok && r\.data && r\.data\.ok && r\.data\.holidays\) setHolidays/.test(JS));
    ok("a setup the grader holds at a missing session says so, and offers no live comparison",
       /if \(p\.grading_gap\) return \{ k: 'gap', word: 'Not graded'/.test(W2) && /nothing guessed/.test(W2)
       && W2.indexOf("if (p.grading_gap)") < W2.indexOf("if (p.state !== 'awaiting_entry')"));
    /* COLOUR KEYS. A colour that encodes a threshold, band or severity the
       number does not print is keyed above the marks, by the one shared
       component, with words beside every swatch. */
    const VJS = readFileSync("public/vision.js", "utf8");
    ok("colour keys: one shared component, and every threshold colour keyed where it is drawn",
       /function key\(items, opts = \{\}\)/.test(W2) && /finished, key \}/.test(W2)
       && ["Bar colour · how often it rose:", "Edge colour · how much each objection weighs", "Row colours:", "Each part, scored 0–100:", "Colours on this page:"]
            .every((t) => JS.includes(t))
       && VJS.includes("A value is coloured by the change written under it:"));
    ok("the map's key states each view's own colours; The call is keyed as categories, not a scale",
       /cats: \[\['mc-5', 'criteria met'\]/.test(JS) && /<p class="maplg" role="note">/.test(JS) && !/<span>low<\/span>\$\{\['mc-1'/.test(JS)
       && ["momentum", "value", "quality", "year", "season"].every((k) => new RegExp(`${k}: \\{ label:[\\s\\S]{0,400}?lo: '`).test(JS)));
    ok("RSI is printed as a level on the stock card, never as a signed, coloured change",
       /lvl\('RSI \(14\)', r\.rsi, '', 0\)/.test(JS) && !/yoy\('RSI', r\.rsi/.test(JS));
    ok("a finished setup's page shows its replay, from the record",
       /precLoad\(\)/.test(V2B) && /window\.V2W\.replay\(t, rec, \{ noSymbol: true \}\)/.test(V2B) && /window\.V2W\.finished\(rec, \{ href: setupHref/.test(V2B));
  }
  ok("counts and rates come from the feed's metrics block, never recounted",
     /const m = d\.metrics \|\| \{\}/.test(V2C) && !/filter\([^)]*outcome === 'win'\)\.length/.test(V2C) && !/\.filter\([^)]*r_multiple/.test(V2C));
  ok("Day 1 shows no completed sample, never a 0% rate",
     /No completed sample yet/.test(V2C) && /m\.win_rate != null \? v2Num\(m\.win_rate, 1\) \+ '%' : '—'/.test(V2C));
  {
    /* 1 Oct 2026: Markets printed Nifty −1.30% while the closes said −0.88%;
       chartPreviousClose held the 29 Sep close. The day's change is measured
       from the last daily close before the quote's own session. */
    const MKT = readFileSync("src/api/markets.js", "utf8");
    ok("Markets measures the day's change from the close before the quote's session",
       /export function prevClose\(res0\)/.test(MKT) && /prevClose\(res0\) \?\? num\(meta\?\.chartPreviousClose\)/.test(MKT)
       && /range=5d&interval=1d/.test(MKT) && /meta\?\.gmtoffset/.test(MKT));
  }
  ok("the disclosure states when the record began",
     /The forward record begins \$\{since \? v2Date\(since\)/.test(V2C) && /The forward record begins 1 October 2026/.test(JS));
  ok("the headline and subheading are the V2 ones",
     /Indian equities, screened after the close\./.test(V2C) && /Review qualified setups, plan the next session, and track every paper trade\./.test(V2C)
     && /Indian equities, screened after the close\./.test(readFileSync("scripts/prerender.mjs", "utf8")));
  ok("no V2 view invents a best-stock pick when nothing qualified",
     /never substitutes a "best stock of the day"/.test(V2B) && /No plan qualified for the/.test(V2C) && /paused: `No plans for the .*new plans are paused\./.test(V2C));
  ok("state is a word plus a glyph, never colour alone", /const V2_STATE = \{[\s\S]*?awaiting_entry:\s*\['Awaiting entry'/.test(V2C) && /<i aria-hidden="true">\$\{i\}<\/i>\$\{esc\(w\)\}/.test(V2C));
  ok("the plan page states stop semantics, management and simulated fills",
     /p\.stop_rule/.test(V2C) && /p\.management/.test(V2C) && /simulated\)/.test(V2C) && /A stop does not cap a gap loss/.test(V2C));
  ok("a scan past its due time reads Overdue, never a past time as pending",
     /const overdue = Number\.isFinite\(due\) && Date\.now\(\) > due/.test(V2C) && /<b>Overdue<\/b>/.test(V2C));
  ok("a failed or incomplete run is named in the strip, never 'scanned after the close'",
     /error: 'the last run failed[,;] plans as of the last good run'/.test(V2C) && /data_unavailable: 'not scanned, data incomplete'/.test(V2C));
  ok("the plan page links the company research into Vision", /v2Vision\(p\.symbol\)/.test(V2C));
  ok("the plan page renders the shared Business section, or says it did not arrive",
     /window\.BriefFundamentals\.render\(scrRow, \{/.test(V2C) && /could not load/.test(V2C) && /screenHref:/.test(V2C));
  ok("no strategy internal ships in the V2 views",
     !/\b(EMA|SMA|ATR|RSI)\d*\b|\bRS63\b|pullback_|depth_atr|touch_band|\.features?\b|\.score\b|\.rank\b|probability of/i.test(V2C));
  /* The V1 feeds are gone from the site, not merely unread. */
  const V1F = ["alerts", "alerts_log", "conviction", "engines", "mandate", "research", "today", "buoy", "vision_eod", "vision_signals"];
  const shipped = V1F.filter((f) => existsSync(`public/${f}.json`));
  ok("no V1 call feed is shipped", shipped.length === 0, shipped);
  const SYNC2 = readFileSync(".github/workflows/sync-data.yml", "utf8"), PULL2 = readFileSync("scripts/pull-feeds.mjs", "utf8");
  const mirrored = V1F.filter((f) => new RegExp(`["\\s]${f}["\\s]`).test((SYNC2.match(/FEEDS="[^"]*"/) || [""])[0]) || new RegExp(`"${f}"`).test((PULL2.match(/const FEEDS = \[[\s\S]*?\];/) || [""])[0]));
  ok("no V1 call feed is mirrored", mirrored.length === 0, mirrored);
  /* engines.js keeps its API for old callers, with an EMPTY roster. */
  const ENGV2 = readFileSync("public/engines.js", "utf8");
  const win = {};
  try { new Function("window", ENGV2)(win); } catch { /* reported below */ }
  ok("engines.js carries no V1 roster", !!win.ENGINE_BOOK && win.ENGINE_BOOK.keys().length === 0 && win.ENGINE_BOOK.inBook({ signal_type: "breakout" }) === false);
  /* The V1 ledger answers 410 with a pointer; quotes and closes stay. */
  const SIGAPI = readFileSync("src/api/signals.js", "utf8"), STAPI = readFileSync("src/api/stats.js", "utf8");
  ok("the V1 ledger API answers 410 Gone, quotes and series stay",
     /status\(410\)/.test(SIGAPI) && /successor: "\/signal_v2\.json"/.test(SIGAPI) && /if \(q\.px\)/.test(SIGAPI) && /if \(q\.series\)/.test(SIGAPI)
     && /return retired\(res\);/.test(STAPI) && /if \(q\.wallet\) return retired\(res\);/.test(SIGAPI));
  const NAVS = [/const CMD_ROUTES = \[[\s\S]*?\n  \];/, /const DISCOVER = \[[\s\S]*?\n  \];/, /const MORE = \[[\s\S]*?\n  \];/,
                /const PRIMARY = new Set[\s\S]*?body\.innerHTML/, /R\['\/404'\] = async[\s\S]*?\n  \};/]
    .map((re) => (JS.match(re) || [""])[0]);
  const stale = NAVS.flatMap((b) => [...b.matchAll(/['"](\/(?:signals|engines|research|ideas|buoy))['"]/g)].map((x) => x[1]));
  ok("no menu, palette, tool list or 404 page sends a reader to a retired route",
     NAVS.every((b) => b.length > 50) && stale.length === 0, stale);
  /* THE SHARED CARDS. One renderer for both sites, reading only what the
     engine computed: it may count sessions, never re-add the record. */
  const W2 = readFileSync("public/v2widgets.js", "utf8"), W2C = W2.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const HTMLV = readFileSync("public/vision.html", "utf8");
  ok("both sites load the one shared widget file, and it is minified",
     /<script src="\/v2widgets\.js"/.test(HTML) && /<script src="\/v2widgets\.js"/.test(HTMLV)
     && /"public\/v2widgets\.js", "js"/.test(readFileSync("scripts/minify.mjs", "utf8")));
  /* Bare var() is allowed only for the card's own --w-* tokens, and each of
     those must be declared in the file with a chain that ends in a literal. */
  const wDecl = Object.fromEntries([...W2C.matchAll(/(--w-[a-z]+):(var\([^;]+?\)|#[0-9a-f]{3,6})(?=;)/gi)].map((x) => [x[1], x[2]]));
  const bareVar = (W2C.match(/var\(--[a-z0-9-]+\)/g) || []).map((v) => v.slice(4, -1))
    .filter((k) => !(k in wDecl) || !/(#[0-9a-f]{3,6}|\d)\)*$/i.test(wDecl[k]));
  ok("every widget custom property ends in a literal fallback",
     Object.keys(wDecl).length >= 8 && bareVar.length === 0, bareVar.slice(0, 5));
  ok("the cards never read or re-add the plan list; totals come from metrics",
     /* The record's plan list is never read here. The paper board reads its
        OWN list (P.plans, a separate block that is not the record), and the
        only sums are over the paper engines' own published counts. */
     !/\b(?:d|F|feed|D)\.plans\b/.test(W2C) && /P\.plans/.test(W2C)
     && (W2C.match(/\.reduce\(/g) || []).length === (W2C.match(/PP\.engines\.reduce\(/g) || []).length
     && /const m = d\.metrics \|\| \{\}/.test(W2C)
     && /h\.nav_change_pct/.test(W2C) && /h\.drawdown/.test(W2C));
  ok("an unexposed book shows no return and no drawdown, and a missing history says so",
     /Not invested/.test(W2C) && /no plan has filled/.test(W2C) && /No session history in this feed yet/.test(W2C)
     && /No sessions recorded yet/.test(W2C) && (W2C.match(/noHistory\(d\)/g) || []).length === 1);
  ok("a missing chart point breaks the line rather than being bridged",
     /if \(p\[key\] == null\) \{ pen = false; continue; \}/.test(W2C));
  ok("the front pages carry the market cards from real closes and the weekly pulse",
     /function v2Market\(nx, pu, d\b/.test(JS) && /series=' \+ encodeURIComponent\('\^NSEI'\)/.test(JS)
     && /W\.nifty\(/.test(JS) && /W\.days\(/.test(JS) && /W\.sectors\(/.test(JS) && /W\.movers\(/.test(JS)
     && /id="hMkt"/.test(readFileSync("public/vision.js", "utf8")));
  ok("a market card that gets no data says so and draws nothing",
     /did not load\.<\/b>/.test(W2C) && /Nothing is drawn in its place/.test(W2C));
  /* The analyst: assembled from the same computed values the cards draw, each
     sentence naming its source card; no model call, no free text. */
  const EXP = (W2C.match(/function explain\(ctx = \{\}\) \{[\s\S]*?\n  \}/) || [""])[0];
  ok("the analyst reads the cards' own computations and names a source for every sentence",
     EXP.length > 500 && /niftyStats\(ctx\.series\)/.test(EXP) && /dayStats\(ctx\.series\)/.test(EXP)
     && (EXP.match(/add\(/g) || []).length >= 6 && !/fetch\(|XMLHttpRequest|api\.anthropic|openai/i.test(EXP)
     && /S0 = niftyStats\(series\)/.test(W2C) && /DS = dayStats\(series/.test(W2C));
  ok("both front pages carry the analyst", /window\.V2W\.explain\(/.test(JS) && /window\.V2W\.explain\(/.test(readFileSync("public/vision.js", "utf8")));
  const TK = readFileSync("src/api/ticker.js", "utf8");
  ok("the rail checks Yahoo's previous close against the daily closes it already holds",
     /const before = pairs\.filter\(\(\[t\]\) => t && istDay\(t\) < qd\)/.test(TK) && /prev_basis: "daily close before this session"/.test(TK));
  const VJ = readFileSync("public/vision.js", "utf8");
  ok("Vision separates research levels from the one actionable stop",
     /'Screen ladder level', r\.lad\.s, 'research reference, not a trade stop'/.test(VJ) && !/'Ladder stop'/.test(VJ)
     && /inside one typical day/.test(VJ) && /The only actionable stop is the Signal plan's/.test(VJ)
     && /Levels from the screen's build/.test(VJ));
  ok("the cards make no forecast", !/probabilit|expected return|likely to|will (rise|fall)|target price/i.test(W2C));
  ok("both pages name a widget bundle that did not arrive",
     /could not load/.test((JS.match(/function v2Widgets[\s\S]*?\n  \}/) || [""])[0])
     && /The record's charts could not load/.test(readFileSync("public/vision.js", "utf8")));
  const VJS2 = readFileSync("public/vision.js", "utf8");
  ok("both mastheads know NSE holidays: Vision reads the calendar, Signal repaints when it lands",
     /get\('\/api\/calendar'/.test(VJS2) && /!NSE_HOL\[k\]/.test(VJS2) && /try \{ tickClock\(\); \}/.test(JS));
  const TICK = readFileSync("src/api/ticker.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("the header rail carries no V1 picks", !/seg\("multibagger"/.test(TICK) && !/multibaggers\(\)\s*[,\]]/.test(TICK));
  ok("the Worker serves the V2 pages and plan URLs",
     /"\/opportunities", "\/performance"/.test(IDX) && /\\\/plan\\\/\[\^\/\]\+\$/.test(IDX));
  const SM = readFileSync("public/sitemap.xml", "utf8");
  ok("the sitemap lists the V2 pages and no retired one",
     /\/opportunities</.test(SM) && /\/performance</.test(SM) && !/\/(signals|engines|ideas|research|buoy)</.test(SM));
  ok("the service worker cache was bumped for V2", /signal-shell-v5/.test(readFileSync("public/sw.js", "utf8")));
  /* Privacy names what is actually stored, and the watchlist can move. */
  const PRIV = (JS.match(/R\['\/privacy'\] = async[\s\S]*?\n  \};/) || [""])[0];
  ok("privacy lists the real local-storage keys",
     ["sig:watch", "sig:alerts", "sig.sizer.v1", "sig:theme"].every((k) => PRIV.includes(k)) && !/One item in local storage/.test(PRIV));
  /* THE UPGRADE (recommendations doc): each state named, each link a next question. */
  ok("home's no-plan state is a designed card with the counts and two ways forward",
     /function v2Gate\(d\)/.test(JS) && /class="v2-gate-b" href="\/opportunities#paper"/.test(JS) && /href="\/methodology#status"/.test(JS)
     && /<h3 id="status">Strategy status<\/h3>/.test(JS));
  ok("the record names 'not started' before its tiles, on the Record page only",
     /Record not started/.test(JS) && /const state = compact \? '' :/.test(JS));
  ok("the watchlist rows carry setup, results, alert and since-last-visit, with five quick filters",
     /function watchTags\(/.test(JS) && ["setup", "results", "alert", "changed"].every((k) => new RegExp(`\\['${k}', '`).test(JS))
     && /data-wquick=/.test(JS) && /RESULTS_SOON = 10/.test(JS));
  ok("the since-last-visit move refuses a missing price instead of reading it as zero",
     /raw == null \|\| raw === ''/.test(JS));
  ok("an empty watchlist says the two sites keep separate lists", /Vision keeps a separate\s+list/.test(JS));
  ok("every cross-site link says why to follow it",
     /Why this company\? Open in Vision ↗/.test(JS) && /How did this become a setup\?/.test(VJS2) && /Not a paper setup tonight\./.test(VJS2));
  ok("Vision's company page has the one-minute read and questions to investigate",
     /panel\('One-minute read'/.test(VJS2) && /panel\('Questions to investigate'/.test(VJS2) && /class="mt-why"/.test(VJS2));
  ok("Vision's home search says what it accepts, and recents can be cleared",
     /id="hHint"/.test(VJS2) && /aria-describedby="hHint"/.test(VJS2) && /data-clr-recent/.test(VJS2));
  ok("Vision's home tiles name where they go", /class="gl-go" aria-hidden="true"/.test(VJS2) && /Open the \$\{dest\} page/.test(VJS2));
  ok("the paper digest's Why button is a real disclosure",
     /class="v2w-why" aria-expanded="false" aria-controls=/.test(W2) && /window\.__v2wWhy/.test(W2));
  /* ROUND 4: alert centre, small upgrades, notes, signed snapshots. */
  ok("/alerts is a real page: Worker PAGES, route meta, the bell's target",
     /"\/watch", "\/alerts"/.test(readFileSync("src/index.js", "utf8")) && /R\['\/alerts'\] = async/.test(JS)
     && /id="bellBtn" href="\/alerts"/.test(HTML) && /"\/alerts": \[/.test(readFileSync("src/route-meta.js", "utf8")));
  ok("the alert centre's first run is a baseline, never a flood", /if \(!prev \|\| !prev\.s\) return \{ baseline: at \}/.test(JS));
  ok("an unmeasured entry check keeps the last measured state", /KNOWN\.has\(k\) \? k : \(was != null \? was : 'na'\)/.test(JS)
     && /was !== 'in' && was !== 'na'/.test(JS));
  ok("price alerts land in the same log the bell counts", /logEvents\(hits\.map/.test(JS) && /const n = evAll\(\)\.filter/.test(JS));
  ok("a first visit tags no setup New", /setupBase && Array\.isArray\(setupBase\.ids\)/.test(JS));
  ok("privacy names every new browser key",
     ["sig:events", "sig:evsnap", "sig:setupsSeen", "sig:visit"].every((k) => PRIV.includes(k)));
  ok("Vision notes stay out of snapshots, and the page says so",
     /data-note=/.test(VJS2) && /It never contains your notes/.test(VJS2) && !/vis:notes/.test(readFileSync("src/api/snapshot.js", "utf8")));
  ok("a snapshot is opened only when its signature holds",
     /if \(!r\.ok \|\| !r\.data \|\| !r\.data\.verified \|\| !r\.data\.snap\)/.test(VJS2) && /Nothing from this link is shown/.test(VJS2));
  {
    const { default: snap } = await import(new URL("../src/api/snapshot.js", import.meta.url));
    const ASSETS = { fetch: async (req) => { const f = "public/c/" + new URL(req.url).pathname.split("/").pop();
      try { return new Response(readFileSync(f), { headers: { "content-type": "application/json" } }); }
      catch { return new Response("", { status: 404, headers: { "content-type": "text/html" } }); } } };
    const call = async (env, q) => { const r = await snap(new Request("https://vision.askakshay.com/api/snapshot?" + q), { ASSETS, ...env });
      return [r.status, await r.json()]; };
    const E = { EDIT_KEY: "guard-only" };
    const anyCo = (() => { try { return readdirSync("public/c").find((f) => f.endsWith(".json")); } catch { return null; } })();
    ok("snapshots are refused, never unsigned, when no key is set", (await call({}, "sym=X"))[0] === 503);
    if (anyCo) {
      const [st, m] = await call(E, "sym=" + anyCo.replace(/\.json$/, ""));
      ok("a snapshot is made from the company file and signed", st === 200 && /^[A-Za-z0-9_-]+\.[0-9a-f]{40}$/.test(m.token || ""), st);
      const [, v] = await call(E, "t=" + m.token);
      ok("...it verifies, and carries the date of every figure", v.verified === true && v.snap && v.snap.asof && "close" in v.snap.asof && v.snap.taken);
      const [b, sg] = m.token.split(".");
      const bad = b.slice(0, 10) + (b[10] === "A" ? "B" : "A") + b.slice(11) + "." + sg;
      ok("...one changed character fails the check", (await call(E, "t=" + bad))[1].verified === false);
      ok("...and a different key fails it", (await call({ EDIT_KEY: "other" }, "t=" + m.token))[1].verified === false);
    } else ok("snapshot round-trip (skipped: public/c is written at deploy)", true);
  }
  /* ROUND 5: the Magic Formula. The ranking is the screen's; the book is the engine's. */
  {
    const IXS = readFileSync("src/index.js", "utf8"), SYNC5 = readFileSync(".github/workflows/sync-data.yml", "utf8"),
          PULL5 = readFileSync("scripts/pull-feeds.mjs", "utf8"), MFR = (JS.match(/R\['\/magic'\] = async[\s\S]*?\n  \};/) || [""])[0];
    ok("/magic is a real page: Worker PAGES, route meta, sitemap, Discover",
       /"\/alerts", "\/magic"/.test(IXS) && /"\/magic": \[/.test(readFileSync("src/route-meta.js", "utf8"))
       && /\/magic</.test(readFileSync("public/sitemap.xml", "utf8")) && /\['\/magic',\s+'Magic Formula'/.test(JS));
    ok("the Magic Formula book is mirrored, schema-checked, in both feed paths",
       /f=magic_book\.json/.test(SYNC5) && /magic-book\/1/.test(SYNC5) && /magic_book/.test(PULL5) && /magic-book\/1/.test(PULL5));
    ok("/magic prints the screen's rank and computes none",
       MFR.length > 2000 && /a\.mf\.rank - b\.mf\.rank/.test(MFR) && !/roc_rank\s*[+]|ey_rank\s*[+]|\.sort\([^)]*roc\b/.test(MFR));
    ok("/magic says why there is no backtest, and that the book is paper", /Why there is no backtest/.test(MFR) && /Paper, forward only/.test(MFR));
    ok("/magic makes no forecast", !/will (rise|beat|outperform)|expected return|probabilit|guarantee/i.test(MFR));
    /* VETTED: a gate and a case. The page prints stock_screen.py::vet() and computes none of it. */
    const VTR = (JS.match(/R\['\/vetted'\] = async[\s\S]*?\n  \};/) || [""])[0];
    ok("/vetted is a real page: Worker PAGES, route meta, sitemap, Discover",
       /"\/magic", "\/vetted"/.test(IXS) && /"\/vetted": \[/.test(readFileSync("src/route-meta.js", "utf8"))
       && /\/vetted</.test(readFileSync("public/sitemap.xml", "utf8")) && /\['\/vetted',\s+'Vetted'/.test(JS));
    ok("/vetted prints the screen's gate and computes no check, count or case",
       VTR.length > 1500 && /SCREEN_META\.vet/.test(VTR) && !/\.filter\([^)]*\b(de|icover|cfo_pat|mcap_cr)\b[^)]*[<>]/.test(VTR) && !/Math\.(random|round)\(/.test(VTR));
    ok("/vetted reads the FULL table: the case is the one field the lite table drops", /!SCREEN \|\| SCREEN_LITE/.test(VTR));
    ok("/vetted says unmeasured is not a pass, and that cleared is not a recommendation",
       /A check that cannot be measured is not a pass/.test(VTR) && /not a recommendation/i.test(VTR));
    ok("/vetted says what an empty case means, about the thresholds and not the company",
       /No measured weakness crossed the screen.s thresholds\. That describes the thresholds, not the company/.test(VTR));
    ok("/vetted makes no forecast and gives no advice",
       !/will (rise|beat|outperform|fall)|expected return|probabilit|guarantee|\b(buy|sell)\b|target price|upside/i.test(
         VTR.replace("a recommendation to buy or sell anything", "")));
    ok("/vetted has the four lenses and the eight tests, and says the history is shorter than the recipe's",
       /Four lenses/.test(VTR) && /data-vtlens/.test(VTR) && /Eight tests/.test(VTR) && /data-vteight/.test(VTR)
       && /A company that could not be measured on a test has not passed it/.test(VTR) && /Not applied: no vetted company could be measured on it/.test(VTR));
    ok("the eight tests and lenses are printed from the screen, never recomputed here",
       /V\.eight/.test(VTR) && /V\.lenses/.test(VTR) && !/\.(roce_med|rev_cagr|r3y_cagr|net_margin|insiders)\b/.test(VTR));
    ok("the screen has an Eight tests preset that waits for the data", /eight:\s+\['Eight tests',\s+r => r\.vet\?\.q\?\.a === true\]/.test(JS) && /k !== 'eight' \|\| SCREEN\.some\(r => r\.vet && r\.vet\.q\)/.test(JS));
    ok("/vetted orders by the screen's own composite and adds nothing to it", /in the order of the screen.s own composite/.test(VTR) && /Vetting adds nothing to it/.test(VTR));
    ok("the screen has a Vetted preset, and the company page prints the gate's one line",
       /vetted:\s+\['Vetted',\s+r => r\.vet\?\.s === 'cleared'\]/.test(JS) && /const vetLine = \(r\)/.test(JS) && /\$\{vetLine\(r\)\}/.test(JS));
    const VJS3 = readFileSync("public/vision.js", "utf8");
    ok("Vision carries the LIMITED version: status and reason only, never the case",
       /r\.vet\.s === 'cleared'/.test(VJS3) && /\['vetted', 'Vetted', 'Quality'/.test(VJS3) && /\['lens_small'/.test(VJS3) && /\['eight', 'Passes the eight tests'/.test(VJS3)
       && ['lsmall', 'lmom', 'ldebt', 'ldiv', 'leight'].every((k) => new RegExp("\\['" + k + "', ").test(VJS3))
       && !/vet\.c\b|vet\?\.c\b|\.vet\.c\./.test(VJS3));
    ok("the screen offers the formula as a preset and a sort, unranked last",
       /magic:\s+\['Magic Formula top 30'/.test(JS) && /if \(k === 'mf'\)\s+return Number\.isInteger\(r\.mf\?\.rank\) \? -r\.mf\.rank : null/.test(JS));
    ok("Vision shows a company's rank, or that it is unranked and why",
       /Magic Formula #\$\{r\.mf\.rank\} of \$\{r\.mf\.of\}/.test(VJS2) && /Not ranked by the Magic Formula: \$\{esc\(r\.mf\.why\)\}/.test(VJS2)
       && /\['magic', 'Magic Formula top 30'/.test(VJS2));
    ok("Vision's Magic Formula preset opens in rank order, so its #1 is /magic's #1",
       /\[\['mf_rank', '<=', 30\]\], \{ sort: 'mf_rank', dir: 1 \}\]/.test(VJS2) && /presetSort\(p\);/.test(VJS2)
       && /k === 'mf_rank' \? 1 : -1/.test(VJS2));
  }
  {
    /* Finish-gate round: contrast and focus measured on the rendered pages. */
    const GC = readFileSync("public/signal.css", "utf8"), GV = readFileSync("public/vision.css", "utf8"),
          GW = readFileSync("public/v2widgets.js", "utf8"), GVJ = readFileSync("public/vision.js", "utf8");
    ok("the brief's --b-* tokens exist outside .brief, so the shared Business section is legible in dark",
       /:root\{\s*--b-bg:var\(--bg\)[\s\S]{0,200}--b-ink:var\(--text\)/.test(GC));
    ok("no text is dimmed with opacity on the ticker, the clock or the flat insight chip",
       !/is-shut \.tkr-n\{opacity/.test(GC) && !/\.wc-i\{[^}]*opacity:\.62/.test(GC) && !/\.scr-ins\.is-flat\{[^}]*opacity/.test(GC));
    ok("split-bar labels take dark ink on the light dark-mode fills", /\[data-theme="dark"\] \.splitb i\{color:var\(--on-ink\)\}/.test(GC));
    ok("Vision's fourth ink holds AA in both themes", /--ink-4:#83868D/.test(GV) && /--ink-4:#6E7279/.test(GV));
    ok("Vision's accent fills carry --on-accent, never a fixed white", /--on-accent:#0F1012/.test(GV) && !/background:var\(--accent\)[^}]*color:#fff/.test(GV));
    ok("heat tiles: theme-aware alphas and dark ink on the strongest dark fill",
       /var\(--ha\$\{i\}/.test(GVJ) && /hk\$\{heatK\(v, sc\)\}/.test(GVJ) && /\[data-theme="dark"\]\{--ha3:\.54\}/.test(GV));
    ok("the screen's search and select show a focus ring, and calendar cells keep their outline",
       /\.scr-in:focus-visible,\.scr-sel:focus-visible\{box-shadow/.test(GC) && /button\.v2w-c:focus-visible\{[^}]*outline:2px solid/.test(GW));
    ok("Signal's screen opens the Magic Formula preset in rank order", /if \(k === 'magic'\) \{ scrSort = 'mf'; scrDir = 'desc'; \}/.test(JS));
  }
  {
    /* Taste pass (2026-10-05): the front pages read as one product, not a template. */
    const TC = readFileSync("public/signal.css", "utf8"), TV = readFileSync("public/vision.css", "utf8"),
          TW = readFileSync("public/v2widgets.js", "utf8"), TVJ = readFileSync("public/vision.js", "utf8");
    const HOME = (JS.match(/R\['\/'\] = async[\s\S]*?\n  \};/) || [""])[0];
    ok("Signal's front page is one hero band: headline and today's sentence, the status facts beside it",
       /class="home-hero/.test(HOME) && /\$\{v2StatusStrip\(d, reg\)\}<\/div>/.test(HOME) && !/head\(H, S, 'Today'\)/.test(HOME)
       && /\.home-hero \.v2-strip>div\{background:none/.test(TC));
    ok("the market on Signal's front page is a line; its four cards moved to Market, not deleted",
       /v2MarketLine\(nx, pu, d, ctx\)/.test(HOME) && !/v2Market\(nx, pu, d, ctx\)/.test(HOME)
       && /out \+= v2Market\(nx, p, null, '', 'The year and the week'\)/.test(JS));
    ok("an empty record on the front page is a sentence, still naming 'Plans published'",
       /compact && !m\.published[\s\S]{0,80}Plans published: 0\./.test(JS));
    ok("shared widgets go flat only when the caller asks", /opts\.flat \? ' v2w-flat' : ''/.test(TW) && /\.v2w\.v2w-flat\{border:0/.test(TW)
       && /flat: true/.test(HOME));
    ok("no em-dash in the front pages' own copy", !/Paper setups — a test/.test(JS) && !/Search a company —/.test(TVJ));
    ok("Vision's hero is four items and its rows alternate wide and narrow",
       /id="hHint" class="hhint vh"/.test(TVJ) && /grid g-21 hrow/.test(TVJ) && /grid g-12 hrow/.test(TVJ) && /\.g-21\{grid-template-columns:minmax\(0,2fr\)/.test(TV));
    ok("the heroes enter once per page load, never under reduced motion",
       /window\.__homeIn/.test(HOME) && /window\.__visHeroIn/.test(TVJ)
       && /prefers-reduced-motion:no-preference\)\{\s*\.home-hero\.is-in/.test(TC) && /prefers-reduced-motion:no-preference\)\{\.hero2\.is-in/.test(TV));
  }
  ok("the watchlist exports and imports, merging rather than overwriting",
     /id="wExport"/.test(JS) && /id="wImport"/.test(JS) && /kind: 'signal-watchlist'/.test(JS) && /new Set\(\[\.\.\.watchAll\(\), \.\.\.clean\]\)/.test(JS));
}

console.log(fails
  ? `\n${fails} of ${checks} guard checks FAILED`
  : `\n${checks}/${checks} guard checks pass (${retired} V1 checks retired by name)`);
process.exit(fails ? 1 : 0);
