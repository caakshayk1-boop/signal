# Phase 0 — trace before redesign (signal.askakshay.com)

**Date:** 2026-09-23 · **Branch:** `design/signal-trust` · **Companion to** `AUDIT.md` (the
19 Sep reviewer pack, unchanged).

The gate: no redesign until every important number can be traced from source to screen. This
file is that trace, plus what measuring turned up.

**How this was measured, and what that limits.** Production is not reachable from the audit
sandbox (egress proxy 403), so nothing here is a production Lighthouse run. The homepage was
rendered by `scripts/vision-dev.mjs` with `VDEV_SITE=signal`: `public/` served as deployed,
`/api/*` answered from **committed** files only (the ledger snapshot `alerts.json`, graded from
its own entry/stop/exit fields with `VDEV_GRADE=1`; pulse; news). No analytics exist in the repo
or the Worker, so **nothing here claims to know which pages get traffic**. The IA section is a
proposal to validate, not a finding.

---

## 1. Architecture map

| Layer | What it is |
|---|---|
| Host | One Cloudflare Worker (`src/index.js`) serving signal, gems and vision by Host header; static assets from `public/` |
| Client | One hand-written SPA, `public/signal.js`: **16,800 lines · 1.0 MB raw · 436 KB min · 148 KB gzip**, + `signal.css` 37 KB gzip. Path routing via `R['/…']`, no framework, esbuild minify at deploy |
| Data, static | JSON feeds built by the `trading-dashboard` pipeline, mirrored twice a day by `sync-data.yml`: pulse, regime, barometer, today, screen(-lite), institutional, engines, alerts (ledger snapshot), data-health … |
| Data, live | Worker `/api/*`: `signals` (Turso, 600 s edge cache; `?px=` quotes), `ticker`, `wire`, `flows`, `stats`, `markets`, `calendar` |
| Shared | `engines.js` (`ENGINE_BOOK`: names, launch date, the in-book predicate), `heatcore.js`, `brief_fundamentals.js` |

Routes (27): `/ /markets /ideas /ipo /screen /research /signals /join /brief /funds /news
/engines /stock/:id /radar /reads /heat /map /discover /methodology /sources /disclaimer
/disclosures /about /terms /privacy /watch`, plus `/buoy → /research`.

---

## 2. Every trust-critical number on `/`, traced

Rendered at 390×844: 330 numeric strings in 9 sections. The per-name conviction cards (188) and
IPO facts are single-field reads and are left out. These are the ones a reader judges the book by:

| Rendered | Section | Code | Field → computation | Population | As-of |
|---|---|---|---|---|---|
| `50 published` | Hero, Record | `signal.js` `LR.published = lrRows.length` | `ledger()` → `/api/signals?limit=400` (fallback `alerts.json`) → `sinceLaunch && !withdrawn` | live engines, long, ₹, since 2026-09-02 | Ledger `generated_at`, or newest row date for the snapshot |
| `15 closed` | Hero, Record | `recordOf(lrRows).trades` | rows with `r_multiple != null` and not open (`isScored`) | same | same |
| `35 still open` | Record tile | `LR.open` | **was** `badge === 'open'`; the bucket counts `status OPEN or badge open` — two definitions (§3 C4, fixed) | same | same |
| `-0.797R · 6.7% · t -3.36 · p 0.005 · CI -1.31R…-0.29R` | Hero, Record | `recordOf` | mean, win share and Student t over `r_multiple` | same | same |
| `50 = 15 + 35 + 0 + 0` | Record reconciliation | `LR.bucket` | one bucket per row | same | same |
| **`52/100`** | "Where the market stands" | `barometer()` in the browser | `pulse.breadth` + ticker Nifty + VIX | 981 screen names, **1-week** returns | pulse `built_on` |
| `427 advancing / 536 declining` | same | `splitBar(pu.breadth)` | `pulse_builder.py`: `up = r1w > 0` | **the week**, not the day | pulse `built_on` |
| `15 closed · -0.797R · t -3.36` | "What kind of market this is" | regime panel | `regime.json → measured.cells[today]` — **computed by the pipeline**, not `recordOf` | NSE, non-retired, published, since launch | `regime.generated_at` (18 h old at render) |
| `+1.472R over 17 closed (t=3.69)` | regime panel note | GUST note | engine history | GUST, **before** launch | — |
| roster `9 · 8 · 12.5%` … | "Which engine" | record section | `lrRows` grouped by engine label | same as the record | Ledger |

---

## 3. Contradictions — two numbers, one question

**C1. Two market barometers.** The homepage's lead number (`52/100`) is computed in the browser
by `barometer()` from `pulse.breadth`. `barometer.json`, built by the pipeline with its own
coverage and published history and read by gems and vision, said **44** the same day. Their
inputs differ: the client feeds `pulse.breadth.up`, a **1-week** count, into a component it
labels **"Advancing today"**. So the site's headline reading disagrees with its own published
barometer, *and* calls a weekly count daily.

**C2. The record, computed twice.** `recordOf` (browser, over `/api/signals` rows) and
`regime.json.measured` (pipeline, over Turso directly) both publish closed / expectancy / t for
the same population. They agree today because every closed trade sits in one regime cell. They
**disagreed** on the day the external audit was written ("47 published, none closed" beside
"11 closed, t = −2.22"). The pipeline grades from exit prices, while the live API rows only carry
`r_multiple` once the grader has written it. The two also run on different clocks (600 s edge
cache vs a 17:47 UTC build).

**C3. Four populations under one brand.** The site record (since launch), the regime cell, GUST's
pre-launch history, and news.askakshay.com's "118 closed of 200" (another site, every engine, no
cutoff). Each is explained in prose beside the number; none can be selected.

**C4. Two definitions of "open"**: `LR.open` (`badge`) vs `bucket.open` (`status` or `badge`).

---

## 4. The `undefined` — root cause

The page rendered *"47 published = **undefined** closed and graded + **undefined** still open +
**undefined** withdrawn before entry + **undefined** expired unfilled"*.

`recordOf` returned early when nothing had closed, **before** it built `bucket`. The
reconciliation line reads `LR.bucket || {}`, so every term was `undefined`, and only on the days
before the first close, which are the days a new reader most needs the arithmetic. **Fixed on
this branch:** buckets are counted first and returned on both paths, and `LR.open` reads the same
bucket.

---

## 5. Measured, locally (not production)

390×844, 4× CPU slowdown, 1.6 Mbps / 150 ms, gzip on, fixture APIs. Indicative only; the dev
harness serves `signal.js` unminified (1.0 MB vs 436 KB), which inflates parse time on every row.

| Route | LCP | CLS | long-task time |
|---|---|---|---|
| signal `/` | **11.6 s** | 0.007 | ~640 ms |
| signal `/signals` | 4.3 s | 0.007 | ~690 ms |
| signal `/markets` | 4.3 s | 0.007 | ~690 ms |
| vision `/` | 1.8 s | **0.159** → 0.001 after this branch | ~360 ms |

- `/` takes 2.7× longer to its largest paint than any other route. The hero waits on a
  `Promise.all` of ten feeds before it can say anything. The shell and skeletons paint early,
  but the LCP element is the hero sentence, and that needs the ledger.
- JS is 148 KB gzip, one file, parsed on every route. The biggest feeds are `screen-lite.json`
  (276 KB gz) and `institutional.json` (105 KB gz, deferred on `/`).
- Vision's 0.159 CLS was the Pulse and Move-leaders bodies growing past their skeletons under
  throttling and pushing the page down. Reserving their measured heights brings it to 0.001
  (390 px) and 0.004 (1440 px).
- **No budget is set yet.** The right one comes after the bottleneck (the feed fan-in on `/`)
  is fixed and re-measured, not before.

---

## 6. Mobile and motion inventory

| Finding | Where | Severity |
|---|---|---|
| Per-second **MYT** clock in the header: wrong timezone for an NSE reader, repaints every second | `signal.js` "live clock, in MYT" | P0 |
| `⌘K` shown as the search hint on phones | `index.html` `.cmdk` | P1 |
| Full SEBI disclaimer block above the fold on phones | `index.html` `.dscl` | P1 |
| Ticker marquee runs **infinitely**; pauses on hover (none on touch); stops only under reduced-motion | `signal.css` `.tkr-t` | P1 |
| Decorative infinite loops: `wcSpin` 42 s, `scan` 9 s, `efSweep` 7 s | `signal.css` | P2 |
| Copy: "both losses" printed for 1–4 closed trades with no win (3 losses → "both") | hero, `LR.trades < 5` branch | P2 |

---

## 7. Ranked findings, and what this branch does

| # | Finding | Priority | This branch |
|---|---|---|---|
| 1 | `undefined` in the reconciliation line | P0 | **fixed** — root cause, plus the empty-book case pinned in the guard |
| 2 | Two barometers (C1) | P0 | **fixed** — `/` leads with the published `barometer.json`; weekly breadth is labelled weekly |
| 3 | Two definitions of "open" (C4) | P0 | **fixed** — one bucket |
| 4 | Record computed twice (C2) | P0 | **already surfaced** — the regime panel prints its own count beside the record's when they differ ("different clock"). One canonical record needs the pipeline and the API to grade identically, which is a `trading-dashboard` change; not in this branch |
| 5 | MYT per-second clock | P0 | **fixed** — IST, relative to the NSE session, repainted per minute, holiday-aware once the calendar answers. It also shared its element with the edition date, which the per-second tick overwrote within a second; both now live in one chip: `Edition 23 Sep · NSE Closed · opens tomorrow 09:15 · 17:09 IST` |
| 6 | Signal integrity: every published signal in exactly one bucket, population, cutoff and as-of in one place | P0 | **added** — the Integrity block |
| 7 | Disclaimer above the fold on phones | P1 | **fixed** — one line opening a sheet; full text unchanged at `/disclaimer` |
| 8 | `⌘K` on phones | P1 | **fixed** — labelled Search pill |
| 9 | Infinite marquee on touch | P1 | **fixed** — paused by default on touch; still scrollable |
| 10 | `/` gated on ten feeds | P1 | open — needs the hero split from the page's other sections; next |
| 11 | "both losses" | P2 | **fixed** |
| 13 | Weekly breadth labelled as today's, on `/` and `/markets`; wins/losses printed as "advancing/declining" on `/signals` | P0 | **fixed** — found while tracing C1 |
| 14 | "0 withdrawn" in the reconciliation is zero by construction (withdrawn rows are filtered out first) | P0 | **fixed** — counted separately in the Integrity block and labelled as outside the book |
| 15 | "8/8 current" with no noun | P2 | **fixed** — "8 of 8 feeds current" |
| 12 | Signal card + "Why this signal?" | P2 | next, after the above is live |

---

## 8. IA — a proposal, not a finding

The external audit proposes `Brief · Screen · Ledger · Watch`. What the code can confirm:

- `/` and `/brief` overlap (both lead with the day and the book), and `/markets`, `/discover`,
  `/heat` and `/map` all present market structure.
- `/signals` is the only route that lists every graded row; `/watch` holds the only per-reader
  state.
- **What the code cannot confirm:** which of these readers actually use. There is no analytics
  endpoint in the Worker and none in the repo, so merging routes on this evidence alone risks
  deleting something a reader depends on.

**Recommendation:** count per-route hits for two weeks first — Workers Analytics Engine, no
cookies, no personal data — and decide the merge on that.
