# Signal V2 — Phase 1 audit

Audited 2026-10-01 against `signal@be47bea` (main after PR #59),
`trading-dashboard@75069ee` and the ledger export `data/all_signals.json` of
2026-09-30 18:50 UTC (823 rows). The live site and its API were **not reachable
from the audit sandbox** (egress proxy 403), so each public observation was
reproduced from the code path that renders it and the feeds or ledger export
it reads. Where the export reproduces the exact public number, this file says so.
Where it cannot, it says that instead.

Status vocabulary: **Reproduced** (same number or behaviour from source and data),
**Reproduced (cause)** (the mechanism is confirmed in code but the exact figure
depends on a live value this audit could not read), **Not reproduced**.

---

## 1. Inventory

### 1.1 Routes (Worker: `src/index.js`)

| Kind | Routes | V2 disposition |
|---|---|---|
| SPA pages | `/` `/brief` `/screen` `/signals` `/markets` `/ideas` `/engines` `/research` `/buoy` `/radar` `/heat` `/map` `/watch` `/stock/:sym` `/ipo` `/funds` `/news` `/reads` `/discover` `/join` `/methodology` `/sources` `/about` `/privacy` `/terms` `/disclaimer` `/disclosures` `/404` | `/` becomes **Today**. `/opportunities` and `/performance` are new. `/plan/:id` is plan detail. `/signals`, `/engines`, `/research`, `/buoy` and `/ideas` show a **retired-version state** that says what changed and links forward. They never map an old call to a new plan. `/brief` shows the current V2 plan or says there is none. `/markets`, `/radar`, `/heat` and `/map` are merged under **Market**. `/watch` is **Watchlist**. The rest move under **More**. |
| API | `/api/ticker` `/api/signals` `/api/stats` `/api/markets` `/api/flows` `/api/calendar` `/api/ipo-live` `/api/wire` `/api/subscribe` `/api/client-error` `/api/heat` `/api/health` `/api/pipeline` `/api/telegram/webhook` | `/api/signals` and `/api/stats` read the V1 table `all_signals`. In V2 both answer **410 with a retired-version body**, and the V1 rows stay in the private database. The market data routes are unchanged. |
| Vision host | `/`, `/company/:sym`, hash routes in `public/vision.js` | Setups reads the canonical V2 plan feed. |
| gems host | `/` → `/gems` | Unchanged. It is not a trade publisher. |
| Server-rendered metadata | `src/seo.js`, `src/route-meta.js`, `scripts/prerender.mjs`, `scripts/company-pages.mjs` | Titles and descriptions are rewritten. The engine names, "every call graded" and "every NSE name" claims are removed. |
| Sitemap | `public/sitemap.xml`, `public/vision-sitemap.xml` | Retired routes are dropped and new routes added. |
| Service workers | `public/sw.js`, `public/vision-sw.js` | The cache version is bumped so no client keeps serving a V1 shell. |

### 1.2 Data producers and the single writer of each mirrored feed

Every feed the site reads is written in `trading-dashboard/docs/` and mirrored by
`signal/.github/workflows/sync-data.yml`.

| Feed | Single writer (trading-dashboard) | Contains V1 calls? | V2 |
|---|---|---|---|
| `today.json` | `generate.py` (from `newspaper.py` picks) | yes: 5 US tickers in USD (SMCI, NET, CRWD, ARM, HOOD) | no longer read |
| `conviction.json` | `generate.py` (`conviction.py`) | ranked "conviction" picks | no longer read |
| `mandate.json` | `generate.py` (`swing_rulebook.py`) | V1 book admission state | no longer read |
| `engines.json` | `generate.py` / `standalone_scan.py` | V1 engine floor | no longer read |
| `alerts.json`, `alerts_log.json` | `generate.py`, `alert_log.py` | V1 alert history | no longer read |
| `research.json` | `scan_research.py` | BUOY/ANCHOR/BEDROCK | no longer read |
| `screen.json`, `screen-lite.json` | `generate.py` (`stock_screen.py`) | research scores and a screen `actionPlan` with a 6%-capped stop | kept as company research; the trade-level ladder is removed from the UI |
| `pulse.json`, `barometer.json`, `regime.json` | `generate.py`, `barometer.py`, `regime.py` | no | kept as Market, with one regime |
| `funds`, `ipo`, `news`, `weekly_reads`, `seasonality`, `swot`, `data-health`, `edition` | `generate.py` and their own jobs | no | kept under More |
| `vision_eod.json` | private engine (`vision-engine/eod.yml`) via the contents API | V2-only, paused | **superseded by `signal_v2.json`**, the one canonical plan feed |

Database (Turso, private): `all_signals` (the V1 ledger; 518 rows `engine_version=v1` and
305 rows `v2`, where that `v2` is an older label and **not** Signal V2), `signals`,
`signals_4h`, `breakouts`, `commodity_signals`, `multibaggers`, `signal_versions`, `scan_meta`,
`scan_log`, `stock_tracker`, `sip_buckets`, `sip_holdings`, `bot_state`, `muted_assets`,
`cf_dedup`, `daily_briefs`, `job_runs`, the `newspaper_*` tables and `content_cache`.
`all_signals` is written by one function, `tracker.log_to_all_signals` /
`log_batch_to_all_signals`, called from `standalone_scan.py`,
`scheduled_tasks_runner.py` and `vision_scan.py`.

The ledger is also exported into the **public** git repository on every scan
(`data/all_signals.json`). The V1 record is therefore already public in git history.
The private recovery copy that Phase 2 calls for is a separate, checksummed copy
in the private `vision-engine` repository plus an in-database archive table.

### 1.3 Engines, including keys that are not on the engines page

From `engine_names.py` and `public/engines.js`:

| Key | Name | V1 state on 2026-09-30 | V2 disposition |
|---|---|---|---|
| `breakout` | BREACH | live | retired. Level detection is re-derived privately inside Compression Retest. |
| `momentum_quant` | VECTOR | live | retired as a publisher. A corrected relative-strength baseline is kept privately (forward-tracked, unpublished). |
| `magic`, `magicmagic` | TIDAL ×2 | `magic` retired 09-18; `magicmagic` live | retired |
| `ledge` | LEDGE | live | retired. Base geometry is re-derived privately inside Compression Retest. |
| `keel` | KEEL | live | retired |
| `pivot` | PIVOT | research | replaced by Trend Pullback |
| `multibagger` | ASCENT | live, "no exit rule" | removed as a publisher |
| `ai_longterm` | NORTH | retired 09-18 | removed as a publisher |
| `intraday` | GUST | live (midday slot) | retired |
| `buoy` `anchor` `bedrock` | research floor | research | retired from public generation |
| `equity_measured` | PLUMB | retired 09-18 | retired |
| `cf_1h`, `commodity`, `ohl`, `4h`, `ai_4h`, `ai_daily`, `4h_momentum`, `swing`, `basebreak`, `manual`, `top5_pick`, `sip_bucket` | ledger-only keys, no public name | various | excluded from India EOD and from every V2 aggregate |
| Vision `bottom`, `brk4h` | Vision legacy | retired 2026-10-01 | grading of open filings stops at the cutover with an archival status |
| US daily picks (`today.json`) | unnamed | live | quarantined. It is not an NSE product. |

### 1.4 Schedulers and alert channels that can emit a V1 call

| Workflow / cron | What it emits | V2 |
|---|---|---|
| `daily_scan.yml` 12:00 UTC weekdays (+14:00, 16:00 retries), 06:00 UTC midday, 04:00 UTC Saturday | equity engines → `all_signals` and Telegram alerts | schedules removed; `workflow_dispatch` kept for the archive |
| `scheduled_tasks.yml` `cf_scan` 10:30/15:30 UTC, `ai_longterm`, morning/night brief | CF scan (silent), brief Telegram | `cf_scan` and the `ai_longterm` arms removed; the briefs stop carrying calls |
| `research.yml` 07:50/10:05 UTC | BUOY/ANCHOR/BEDROCK feed | schedule removed |
| `vision_scan.yml` 10:15 UTC | grades open Vision legacy filings | schedule removed; open filings end with an archival status |
| `stock_alerts.yml` | per-stock alerts from the screen | unchanged (research alerts, not calls), but reviewed |
| Cloudflare watchdog (`src/watchdog_schedule.js`) | re-dispatches missed slots | legacy slots removed, or it would re-run them |
| Telegram bot (`src/bot/*`) | personal commands | the personal position store is preserved untouched |

---

## 2. Public observations

| # | Observation | Status | Root cause (source) | Correction in V2 |
|---|---|---|---|---|
| 1 | Home 57 calls / 26 closes / 4W 22L 15.4%; Ledger 57/26 but 2W 20L 9% | **Reproduced exactly** from the 2026-09-30 export with the site's own filters: 57 published, 26 scored. Wins by `r_multiple > 0` = **4**; wins by status badge = **2**; losses = **20**. BLUESTARCO (#1052, +0.69R) and JUBLPHARMA (#1039, +0.41R) are EXPIRED with positive R. | Two win definitions. `recordOf()` (`public/signal.js:1201`) counts `r_multiple > 0`. The ledger counts `badge === 'win'` from `badgeOf()` (`src/api/_badge.js`), which is status-based and puts EXPIRED in neither bucket. | One canonical metrics block computed once by the private engine from final net P&L. A position is a win, loss or breakeven by its net P&L, never by exit reason, and closed = wins + losses + breakevens. Every view reads that block. |
| 2 | Engines summary 64 open / 42 closed vs cards 31/26; dates 2 Sep and 3 Aug mixed | **Reproduced (cause)** | `engines.json` is computed over every engine key (retired and ledger-only included) from 2026-08-03, while the cards filter to the live roster since `LAUNCH = 2026-09-02`. The export shows 64 OPEN across all keys since launch, which matches the summary's open figure. | One population, declared in the payload (`population`, `since`), and no per-engine public cards. |
| 3 | BREACH card 6 closes vs dialog 27; LEDGE 3 vs 0; KEEL 6 vs 5 | **Reproduced (cause)** | The card counts the current cohort (`sinceLaunch`) and the dialog reads the engine's all-time backtest/ledger table. Same mechanism as #2. | Engines removed from public. |
| 4 | Universe 750 / 988 / 989 vs "every NSE name" | **Reproduced** | Hardcoded fallback `989` (`signal.js:2112`); copy says "750 names" in several places; headline "Every NSE name" (`signal.js:3098`, `index.html:293`). The screen is the Nifty 500 plus an extension, about 989 rows, and NSE lists about 2,300 equities. | Counts come from the run's `coverage` only. Copy says "liquid NSE equities", and a missing count is shown as missing. |
| 5 | STLTECH three risk plans: 823.75/765.21; 866.60/814.60; stop 797.27 | **Partly reproduced.** 823.75/765.21 is ledger row #1118 (VECTOR, 2026-09-26). 866.60 is the screen close and 814.60 = 866.60 × 0.94, the screen's own **6%-capped** `actionPlan` stop (`stock_screen.py:SCREEN_SL_MAX_PCT`). 797.27 is not in the export; the nearest is row #1057's 797.02. | Three code paths compute levels independently: the engine ledger, the screen `actionPlan`, and the brief. | One `TradePlan` per symbol per session, with an immutable id. Screen, brief, stock page and Vision read it by id, and no view computes its own levels. |
| 6 | Brief T1/T2 at 2.0R/2.9R, R:R prose, ledger R:R 3.70; T3 far down | **Reproduced (cause)** | `rr` is stored as one number, measured off T1 in one engine and off T2 in others (`scanner.py:2559` comment). The brief recomputes it from live price. | Explicit `rr_t1`, `rr_t2` and `rr_t3` from the plan's own entry cap and stop, all three targets shown together. |
| 7 | Brief advertises scale-out/trailing; ledger grades the original fixed stop | **Reproduced (cause)** | Brief copy (`ENGINE_RULES`) describes management that `tracker.update_all_outcomes` does not grade. | The management policy is frozen in the plan (`fixed` in v2.0) and grading follows exactly that policy. |
| 8 | STLTECH shown with 94 confidence while 10.46% past entry | **Reproduced (cause)** | The score is stamped at build and shown beside the live price (see CLAUDE.md, "score keeps its value and says at build"). | No confidence score anywhere. A plan past its entry cap reads **Extended — not eligible**. |
| 9 | Targets lifted to R:R floors through nearer resistance; stops capped inward | **Reproduced** | `scanner.py:2553–2555` `_t = max(_t, price + R_MULT × risk)`; `signals/indicators.py:_tight_sl` `sl_capped = max(sl_raw, price × (1 − max_pct))` with `max_pct = 0.06` pulls a structural stop inward; `exit_rules_v2.py:172` `cap = min(0.06 × hz, 0.20)`. | Risk-first construction: the stop sits below structure plus a buffer and is never capped inward. Targets come from known levels and are never lifted, and the plan is rejected if three defensible levels do not exist. |
| 10 | VECTOR: sigma in one description, ATR in another | **Reproduced** | `engines.js:116` says "over one-year sigma"; `signal.js` `ENGINE_RULES.momentum_quant` says "divided by the name's own ATR". The implementation (`momentum_engine.py:159`) uses the 1-year return SD and falls back to `atr_pct` below 60 observations. Two different units under one name. | VECTOR is retired. The private RS baseline is documented once in its pre-registration. |
| 11 | ASCENT has no exit rule but has closed trades | **Reproduced** | `ENGINE_RULES.multibagger.wrong`: "claims no exit rule". `swing_rulebook` still grades `multibagger` rows with a horizon stop; 4 since launch in the export. | Removed as a publisher. |
| 12 | TIDAL self-referential docs; `magic`/`magicmagic` aliases | **Reproduced** | `ENGINE_RULES.magicmagic.stop`: "Same levels function as TIDAL"; two keys publish one name (`engine_names.py:44–45`). | Retired. Registry ids are distinct from names and can never be shared. |
| 13 | GUST/PIVOT trigger docs missing; candle/VWAP claims vs "OHLC/VWAP unavailable" | **Reproduced (cause)** | `ENGINE_RULES` has no `pivot` entry, and `intraday` reads 15-minute bars, while `/sources` says intraday OHLC/VWAP is not available to the site. | Retired. V2 is daily bars only and the sources page says so. |
| 14 | Ideas mixes SMCI/NET/CRWD/ARM/HOOD and USD | **Reproduced** | `today.json` `picks` = 5 US tickers, currency `$` (`R['/ideas']` reads it). | Ideas is merged into Opportunities, which is NSE only. US picks are quarantined. |
| 15 | Barometer vs radar scores; breadth mixes daily/weekly and runs | **Reproduced (cause)** | `barometer.json` (Python, 984 names, score 33) and the client-side `barometer()` (`signal.js:9461`, its own `BARO_W` weights) are two implementations. `regime.json` is a third label (`calm_range`). | One regime state with definitions. The barometer score is read from the feed and never recomputed in the browser. Every breadth figure carries its period and universe. |
| 16 | CUPID quote above the annual high while a label says below it | **Reproduced (cause)** | `high52` comes from the nightly screen and the quote is live, and the label compares the build-time close to the stale high. | The range label is computed from the same source and time as the quote, and "new high since build" is shown when the quote exceeds it. |
| 17 | TRADING NOW / LIVE while the market is closed | **Reproduced** | `liveMark()` (`signal.js:7929`) prints "Trading now" whenever a quote exists, and the `Live` session pill depends on a field the quote API does not always set. | The label reads from the NSE session state and calendar: "Last price · as of HH:MM IST" when closed, with the quote's actual delay. |
| 18 | Market clocks ignore holidays; another page knows the next holiday | **Reproduced** | `exchangeState()` (`signal.js:4303`) checks only *today* against `NSE_HOLIDAYS`, and the next-open arithmetic skips weekends only. Non-NSE exchanges have no holidays. | Next session comes from the NSE calendar (the same one the engine uses). Other exchanges say "holidays not tracked". |
| 19 | STLTECH promoter % differs across blocks; percentile polarity | **Reproduced (cause)** | Two sources: the screen's shareholding (`x.promoter`, noted at `signal.js:6488` as reading above SEBI's definition) and the insider/holding field used at `signal.js:7834`. `pe_pctile` is "PE vs own 5-year range", where low means cheap, and peer percentile is higher-is-better. The same word carries opposite polarity. | Each block names its source and date. Percentiles are labelled with direction ("0th = cheapest in 5 years"). |
| 20 | Privacy says only theme is stored; Watchlist stores symbols and alerts | **Reproduced** | `/privacy` (`signal.js:15658`): "One item in local storage: your light or dark preference". In fact `localStorage` holds theme, density, watchlist, alerts and last-visit, and `sessionStorage` caches feeds. | Privacy lists the actual keys. Watchlist adds import/export and a local-only notice. |

---

## 3. Structural findings that drive the V2 design

1. **Many writers, one table.** Fourteen-plus engine keys write one ledger through one
   function, and six readers each re-derive counts with different filters. V2 has one
   writer (the private engine) and one public projection (`signal_v2.json`), with
   metrics computed once.
2. **Levels computed in three places.** Ledger, screen and brief disagree by design. V2
   has one plan id and no client-side level arithmetic.
3. **Risk construction ran backwards.** Caps and floors were applied *after* structure. V2
   starts from structure and rejects the plan when the risk is too large.
4. **Research status did not gate publication.** `multibagger`, `pivot` and `intraday`
   published while labelled research. In V2, registry status gates publication in code:
   only `forward_paper` and `validated` may publish.
5. **The old record is unrecoverable as evidence.** 57 calls and 26 closes at a losing
   expectancy cannot validate anything new. It is archived privately and excluded,
   never netted against V2.

## 4. What this audit did not verify

- Live API responses. The figures come from the 2026-09-30 ledger export and code.
- The 797.27 STLTECH stop. It is not in the export.
- Third-party caches, emails or screenshots of V1 calls. These cannot be recalled and
  the site does not claim otherwise.
