# Vision — audit against the 30 Sep 2026 review

**Scope:** vision.askakshay.com, the child product. Same method and limits as `SIGNAL_AUDIT.md`:
claims checked in code; measurements local and throttled, not production Lighthouse.

## 1. Architecture

| Layer | What it is |
|---|---|
| Shell | `public/vision.html`, one hash-routed app in `public/vision.js` (~2.2k lines) + `vision.css` |
| Edge | **New:** the Worker writes `/` and `/company/<KEY>` itself (`src/seo.js`) — own title, description, canonical, Open Graph, JSON-LD, and a readable body |
| Company data | **New:** `public/c/<KEY>.json`, ~4 KB per company, cut from `screen.json` + `institutional.json` + `vision_signals.json` at deploy (`scripts/company-pages.mjs`) |
| Synthesis | **New:** `public/insight.js` — "what matters" and "what changed", deterministic, one file run by both the Worker and the browser |
| Feeds | screen-lite, barometer, regime, pulse, institutional, news, vision_signals; live `/api/ticker`, `/api/signals?px=` (quotes only), `/api/wire`, `/api/heat` |

## 2. The review's claims, checked

| Claim | Verdict | Evidence / action |
|---|---|---|
| Crawlable HTML is a disclaimer, a search box and "Vision needs JavaScript" | **True** | `<main>` was empty and the only body text was the `<noscript>`. Now the home and 984 company pages are written by the server. |
| Positioning is vague ("market cockpit") | **True** | Home is now company search: "Understand any Indian company in minutes." The cockpit is kept at `#/cockpit`. |
| Vision duplicates Signal (markets, screener, watchlist, news, signals) | **True** | Not deleted — these were built at the operator's request a week earlier. Re-ordered: the primary nav is the research path (Companies, Compare, Signals, Screener, Heatmap, Today); Cockpit, Markets, News, Watchlist and Alerts sit under More. Removing any of them is the operator's decision. |
| No link to Signal | **True by design until now** | The 23 Sep build removed every Signal link on instruction. Reversed: "← Signal" in the header, on the home, in ⌘K, and "On Signal ↗" on every company. |
| Robots `noindex` on every page | **True** | Now `index,follow` on the vision host's home and company pages. The file keeps `noindex` for its duplicate at `signal.askakshay.com/vision`. |

## 3. What the data supports, and what it does not

| Review asks for | Supported? | Done |
|---|---|---|
| What matters / What changed, with sources | Yes — annual statements (4 FY medians), YoY vs CAGR, margin change, ROCE vs its median, FII/DII q/q, since-last-build score deltas, results dates | **Yes**, every line with basis and source; thresholds printed |
| Compare mode with key differences | Yes, from the same fields | **Yes**, `#/compare`, up to five, no row coloured "better" |
| Metric definitions | Yes | **Yes**, glossary buttons (R, ATR, ROCE, PE percentile, cash conversion, relative strength, volume spike…) |
| Recent searches, highlighted matches, keyboard | Yes | **Yes** |
| Quarterly statements, QoQ | **No** — the screen carries annual figures only | Not built; needs a quarterly feed upstream |
| Filings / events timeline | **No** — no filings feed; only a next-results date | Results date shown as an event, labelled "confirm on the exchange" |
| Price chart with event markers | **No** — no per-stock bar history is published | Still links out to TradingView |
| Ownership over time | Partly — four quarters of FII/DII in `institutional.json` | q/q change shown; a four-quarter chart is next |
| Ask Vision (evidence-constrained Q&A) | **No backend** | Not built. A UI with no working backend would be a fabricated feature. Contract below. |

**Ask Vision — the contract, for when a backend exists.** `POST /api/ask {sym, q}` → `{answer,
claims:[{text, source, field, value, as_of}], uncertain:[…], refused?:reason}`. The server
retrieves only `/c/<KEY>.json` plus the wire items that name the company; every sentence must map
to a claim; no figure may appear that is not in a claim; a question asking what to buy is refused.

## 4. Measured (local, 390 px, 4× CPU, 1.6 Mbps / 150 ms, unminified)

| Page | FCP | LCP | CLS |
|---|---|---|---|
| `/` (Companies) | 0.84 s | 1.38 s | 0.012 |
| `/company/RELIANCE` | 0.84 s | 1.26 s | 0.003 |

The first cut of this work measured CLS **0.64** on the company page and 0.23 on the home: the
header skeleton was a fraction of the header's height. Heights are now reserved.

## 5. Staged plan

1. A quarterly results feed upstream → Financials tab (quarterly/annual, YoY/QoQ).
2. Four-quarter ownership series on the company page (data already there).
3. A filings feed (NSE corporate announcements) → an events timeline.
4. Only then an evidence-bound Ask Vision, to the contract above.
