# Signal — audit against the 30 Sep 2026 review

**Scope:** signal.askakshay.com (parent product). **Method:** every claim in the external review
checked against the code in this repo, not the live site. Production is not reachable from the
sandbox this was written in (egress proxy), so nothing here is a production Lighthouse score.
Measurements are local: `wrangler dev`, 390 px, 4× CPU slowdown, 1.6 Mbps at 150 ms, unminified.

Companion to `AUDIT.md` (19 Sep reviewer pack) and `AUDIT-PHASE0.md` (the number trace).

## 1. Architecture (current)

| Layer | What it is |
|---|---|
| Host | One Cloudflare Worker, `src/index.js`, serving signal / gems / vision by Host header |
| Edge HTML | **New:** `src/seo.js` rewrites each route's head and pre-render with HTMLRewriter |
| Client | `public/signal.js` — one hand-written SPA, path routing via `R['/…']`, ~17k lines, 148 KB gz in production |
| Data | JSON feeds mirrored from trading-dashboard by `sync-data.yml`; `/api/*` from Turso and Yahoo |
| Build | `npm run deploy`: pull feeds → route meta → company pages → pre-render → CSP hashes → guard → minify → deploy |

Pages (27): `/ /markets /discover /watch /signals /brief /ideas /screen /heat /map /reads /radar /engines /ipo /news /funds /research /methodology /sources /about /disclaimer /disclosures /terms /privacy /join /stock/:sym`, plus `/buoy → /research`.

## 2. The review's claims, checked

| Claim | Verdict | Evidence |
|---|---|---|
| Different routes serve effectively identical HTML | **True** | Every page path got `index.html` unchanged: one title, description, canonical and pre-render. `signal.js` corrected the head only after running. |
| `/about` etc. read as the home page | **True, and worse** | `/about`, `/disclaimer`, `/disclosures` had no row in `META`, so even the client fell back to the front page's title and canonical. |
| The disclaimer shows twice near the top | **Partly** | The static block has a desktop paragraph and a phone `<details>`; CSS shows one. A text-only crawler reads both copies. Left as is: removing either weakens a disclosure that must survive a failed bundle. |
| Nav should be Today · Markets · Discover · Watch · Signals · Ledger | **Partly adopted** | "Home" → "Today". A separate "Signals" tab was **not** added: `/signals` *is* the published signals and their outcomes (its page title is "Signals — the public ledger"); a second tab would name two destinations the same. |
| Ledger needs ALL / ACTIVE / CLOSED / POSITIVE / NEGATIVE | **Mostly existed** | All / Open / Winners / Losers / Expired were there. **Closed** was missing; added. |
| No "Open in Vision" | **True** | Fixed through `symLinks()`, the one helper behind every stock link. |
| Needs sitemap/robots | **Existed, stale** | `sitemap.xml` was hand-written 08 Sep, missing six live routes. Now generated at deploy from the route table. |

## 3. Other findings

- **Verdict wording — fixed 30 Sep.** The screen's `vd.c` was shown as "Buy" / "Avoid" (and raw
  "BUY" on stock pages and the map), instructions on a site whose disclaimer says nothing here is
  a recommendation. The codes in the data are unchanged; readers now see what the code means:
  **Criteria met** (BUY), **Entry not met** (WAIT), **Watch**, **Fails screen** (AVOID), **Not
  rated**. One table in `signal.js`; Gems holds the same words; the guard pins both and refuses an
  instruction-shaped word.
- **Index feed was null — fixed 30 Sep (trading-dashboard).** Two causes: the barometer took an
  unclosed bar when its cron landed after midnight IST, and the screen dropped `^NSEI` once the
  universe hit 1,000 names (it fell alone into a batch whose single-ticker parse was wrong).
- **Scheduled scans run hours late.** `vision_scan.yml` is set for 07:58 and 10:15 UTC; the nine runs
  so far started 13:04–18:10 UTC (GitHub cron under load). The rule reads only completed bars, so
  the signals are correct but late. **Fixed:** `vision_scan.yml` is now a watchdog entry
  (`src/watchdog_schedule.js`), dispatched 12 minutes after a missed slot; the two follow-up
  syncs moved to 08:40 / 10:55 UTC and are watchdog slots too, pinned equal by the guard.
- **Performance.** `/about` measured LCP 3.5 s, CLS 0.05 under throttling (unminified dev build).
  The bottleneck identified in AUDIT-PHASE0 (the home page waits on ten feeds; one 148 KB-gz bundle
  for every route) is unchanged. No budget is claimed.
- **Analytics.** Only Cloudflare Web Analytics' page-view beacon exists. The review's event list
  (search, filter, Vision opened…) needs Workers Analytics Engine; not added.

## 4. Target and migration

Done in this pass: edge-written heads and bodies for every route (§2), sitemap from the route
table, "Today", Closed filter, Vision links in the bar, on every stock row, on the stock page and
in ⌘K.

Next, in order: (1) split the home page's hero from its ten-feed
`Promise.all` (AUDIT-PHASE0 #10) and set a JS budget after measuring; (2) Workers Analytics
Engine for the events, cookie-free.
