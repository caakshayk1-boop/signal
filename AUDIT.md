# signal.askakshay.com — audit pack

**Prepared:** 19 September 2026 · **Site:** https://signal.askakshay.com ·
**Sibling product:** https://gems.askakshay.com (same Worker, same data, different presentation)
**Owner:** Akshay Kothari — Chartered Accountant, FP&A. Personal project, no employer affiliation.

This document is written to be **checked, not believed**. Every factual claim below carries the
command or URL that verifies it. Where something is unverified, unresolved or a judgement call,
it is marked as such rather than omitted — including the parts that do not flatter the product.

---

## 1. What the site is, in one paragraph

A free, public equity-research site covering NSE-listed companies. It screens the market before
every session, publishes ranked candidates with an entry level, a stop and three targets, and
**grades every one of them when it closes** — wins and losses both — into a ledger that is
public and complete. It is not registered with SEBI, takes no money in any form, and cannot
place a trade. Its own published expectancy is currently **negative and statistically so**, and
the front page says that in the largest type on the site.

---

## 2. The published record — the number that matters most

Measured from the live ledger at the time of writing (`/api/signals`, generated
`2026-09-18T23:15:25Z`):

| measure | value |
|---|---|
| Published since launch (2026-09-02) | **45** |
| Closed and graded | **13** |
| Still open | 32 |
| Withdrawn / expired | 0 |
| Wins / losses | 1 / 12 |
| Win rate | 7.7% |
| Expectancy | **−0.765R** |
| t-statistic | **−2.79** (12 df) |
| Two-sided p | **0.016** |
| 95% CI on expectancy | **[−1.363R, −0.168R]** — excludes zero |

**Interpretation, stated precisely.** The interval excludes zero, so the *sign* is settled: this
book is losing money and that is not attributable to chance at the 5% level. The *size* is not
settled — an interval running from −0.17R to −1.36R is the difference between a small leak and a
serious one, and 13 trades cannot distinguish them. The site's own bar for trusting an engine is
**30 closed trades at t ≥ +2**, and nothing on the board is close to it.

**A correction to a common framing.** It is tempting to say "12 losses in 13 is a 1-in-585 coin
flip" (P = 0.0017 at a 50% win rate). That overstates the case: 50% is the wrong null for a
system with asymmetric payoffs — at a 1.6R first target the break-even win rate is about 38%.
The t-test on the R-multiples prices the asymmetry directly and is the test quoted above.

**Verify:**
```bash
curl -s "https://signal.askakshay.com/api/signals?limit=400"
```
Filter to `signal_type` in the live roster (§4), `action != SELL`, `currency == ₹`,
`date >= 2026-09-02`, and `r_multiple` non-null. The page computes it in
`recordOf()` in `public/signal.js`; there are no hardcoded statistics anywhere in the render
path.

### Per-engine, since launch

| engine | closed | expectancy |
|---|---|---|
| VECTOR | 7 | −0.564R |
| KEEL | 3 | −1.000R |
| BREACH | 2 | −1.000R |
| ASCENT | 1 | −1.000R |
| PIVOT · TIDAL · LEDGE · GUST | 0 | — |

---

## 3. Architecture

Single **Cloudflare Worker** serving two hostnames. No server-side rendering framework, no
database on the request path for page loads, no user accounts.

```
                    ┌───────────────────────────────────┐
  browser ─────────▶│  Cloudflare Worker (src/index.js) │
                    │   · 10 /api/* routes              │
                    │   · static assets binding         │
                    │   · SPA route table (27 pages)    │
                    │   · security headers on every     │
                    │     response (one wrap point)     │
                    └───────────────┬───────────────────┘
                                    │
             ┌──────────────────────┼──────────────────────┐
             ▼                      ▼                      ▼
     20 static JSON feeds    Turso (read-only,      upstream APIs
     built upstream,         the signal ledger)     (Yahoo, NSE, RSS)
     synced on a schedule
```

| component | file | lines |
|---|---|---|
| Worker + routing + headers | `src/index.js` | 449 |
| Main app bundle | `public/signal.js` | 16,241 |
| Shared cross-site contract | `public/engines.js` | 311 |
| Gems bundle | `public/gems.js` | 1,860 |
| UI test suite | `test/ui.mjs` | 2,332 |
| Static guards | `test/guard.mjs` | 926 |

**API routes:** `/api/health` `/api/pipeline` `/api/ticker` `/api/signals` `/api/stats`
`/api/markets` `/api/flows` `/api/calendar` `/api/wire` `/api/subscribe`

**The only write path in the entire system is `/api/subscribe`** (email capture). Everything
else is read-only. There is no authentication, no session, no user data store, no payment path.

**Cron:** `*/10 * * * *` — a watchdog that reports pipeline status. It is deliberately
read-only from the browser (`/api/pipeline` does not trigger builds; a status endpoint that
starts jobs because someone looked at it is a trap).

---

## 4. Engines — what publishes, and what does not

**Live (8):** PIVOT · BREACH · TIDAL · ASCENT · VECTOR · LEDGE · KEEL · GUST
**Retired 2026-09-18 (3):** TIDAL's shallow band (`magic`) · PLUMB (`equity_measured`) ·
NORTH (`ai_longterm`)

Retirements were made on measured grounds, not judgement: PLUMB closed 16 trades at −0.535R,
t = −2.92 — the only engine whose record was *significantly* negative. NORTH had no closed
trade at all. A retired engine keeps its display name forever so its historical rows never
render as raw database keys, but it is excluded from every published count.

**The roster is defined once**, in `public/engines.js`, and read by both browser bundles.
`engine_names.py` is the single Python mirror, and `test_engine_names.py` parses the JS and
asserts the two agree in **both directions** — same keys, same names, same retirement dates,
same bands.

**Verify:**
```bash
curl -s https://signal.askakshay.com/engines.js | grep -c "retired:"
```

> **Audit note — this was a real defect, found and fixed in this cycle.** The same fact ("which
> engines publish here") was written in **seven** places and six were wrong. The front page was
> counting three retired engines into its own published record: it read 65 published / 12 closed
> / 8.3% / −0.746R when the correct figures were 45 / 11 / 9.1% / −0.723R. The fix was not to
> correct six copies but to remove them.

---

## 5. Data — sources, flow and the staleness model

### Upstream sources

| source | used for |
|---|---|
| Yahoo Finance (`query1.finance.yahoo.com`) | prices, OHLC, volume |
| NSE India (`nseindia.com`) | IPO calendar, corporate actions, institutional flows |
| Moneycontrol · Economic Times · Business Standard · Mint · BusinessLine · CNBC · FT · Bloomberg (RSS) | the news wire — headline, link and attribution only |
| gold-api.com | metals |

All upstreams are fetched **server-side by the Worker**. The browser never calls a third party.
The CSP enforces this (`connect-src 'self'`), so if that ever changes the console says so
immediately — which is the correct way to discover that a key has moved into the client bundle.

### Two clocks, and why figures can differ legitimately

This is the single most important thing for an auditor to understand about the numbers.

| surface | source | freshness |
|---|---|---|
| Ledger record, heatmap, live marks | `/api/*` — computed per request | live |
| Screen fundamentals (ROCE, D/E, margins) | `screen.json` — built ~02:10 IST | build-time, by necessity |
| Regime panel | `regime.json` — built on a schedule | snapshot, stamped |

A fundamental cannot be live; a price can. Where both exist for one name the site now shows the
live price and states what the build was made from. Where a live quote is unavailable it labels
the figure **"screen close"** rather than calling it "today".

> **Audit note — a real defect, found and fixed in this cycle.** A smart-tool sheet printed
> TATACHEM at ₹731.80, "−0.40% today", while the same page's heatmap showed −11.04% and the
> stock traded at ₹693.25. Neither number was invented — ₹731.80 was the close the screen was
> built from. The defect was the word *today*. Live quotes were already on the page
> (`/api/ticker` carries 103) but were reachable only from one route.

The regime panel now states its own age and reconciles itself against the live record in words
when the two differ, e.g. *"Measured 2h old, on 11 closed trades. The record above reads 13,
because it is computed from the live ledger on every load and 2 more trades have closed since.
Same engines, same rule, different clock."*

---

## 6. Regulatory position

**Not registered with SEBI** as a Research Analyst or an Investment Adviser.

SEBI's Research Analyst Regulations treat buy/sell/hold calls, price targets, stop-loss levels
and model portfolios as **research services**, with the trigger for registration being
**consideration**. Publishing research free of charge does not require registration; charging
for it does, in any form — a subscription, a paid channel, or a tip jar attached to the same
output.

**Current state, all independently checkable on the live site:**

- No paid tier, no subscription, no paywall
- No paid Telegram or Discord channel
- No affiliate link to any broker, exchange or data vendor
- No advertising, no sponsorship, no paid placement of any name on any list
- No payment page and no payment processor integrated anywhere in the codebase

**Disclosure surfaces:** a persistent bar above the fold on **every route of both sites**,
written into the static HTML shell so it is present on first paint, before any JavaScript runs,
and in the crawler's copy of the page. Plus `/disclaimer`, `/disclosures`, `/about`, `/terms`,
`/privacy`, `/methodology`, `/sources`.

**Open item, owner's decision:** if the site ever charges, registration must come first. Part-time
RA registration (graduation in any discipline + NISM Series XV; BSE RAASB portal since July
2024) appears to fit the owner's circumstances. Figures circulating internally —
₹15,000 + GST in fees, a lien-marked FD deposit, 3–4 months processing — **should be verified
against sebi.gov.in and the RAASB portal before any filing.** They are not verified here.

---

## 7. Security posture

| control | status |
|---|---|
| HTTPS, HTTP→HTTPS redirect (single hop, no loop) | ✅ verified |
| `Content-Security-Policy` | ✅ **no `unsafe-inline` for scripts** |
| `Strict-Transport-Security` | ✅ `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options: nosniff` | ✅ |
| `Referrer-Policy: strict-origin-when-cross-origin` | ✅ |
| `Permissions-Policy` (geolocation, mic, camera, payment, USB all denied) | ✅ |
| `frame-ancestors 'none'` + `X-Frame-Options: DENY` | ✅ |
| `Cross-Origin-Opener-Policy: same-origin` | ✅ |
| Secrets in the browser bundle | ✅ none — see below |

**On the CSP.** Three inline `<script>` blocks cannot become files: the theme bootstrap must run
inline and blocking or the page paints the wrong background and then flips. They are named **by
SHA-256 hash** rather than permitted via `unsafe-inline`. The hashes are generated at build time
(`scripts/csp-hashes.mjs`) and a guard fails the build if they drift from the HTML — because a
stale hash blocks the site's own code, which is a white page in production caused by a security
control.

`style-src` **does** allow `'unsafe-inline'`, and the reason is stated rather than hidden: the
app positions bars, tiles and heat cells by writing `style=""` from live data on every render —
a split bar's widths *are* the breadth numbers. Removing that is a rewrite of the rendering
layer. An inline style is a far weaker vector than an inline script.

**Secrets.** Three environment values exist: `TURSO_URL`, `TURSO_TOKEN` (read-only ledger
access) and `EDIT_KEY`. All are Worker-side. None is prefixed in any way that would ship to the
browser, and `connect-src 'self'` means the browser cannot reach a third party even if one
leaked.

**Verify:**
```bash
curl -sI https://signal.askakshay.com/ | grep -iE "content-security|strict-transport|x-content-type|referrer|permissions|frame"
```

> **Status caveat, stated plainly:** these headers are implemented and verified on a local
> Worker with zero CSP violations across 12 routes. At the time of writing they are **pending
> deployment**. Re-run the command above and confirm before relying on this section.

---

## 8. Data-integrity controls

The site publishes numbers, so the controls are about numbers rather than uptime.

**93 static guards** (`test/guard.mjs`) run before every deploy and fail the build. Each one
exists because a specific defect reached production. The most relevant to an auditor:

- **Every published partition must reconcile.** The front page once read "160 of 985 screened
  names advanced and 818 declined" — 160 + 818 = 978, with seven names unaccounted for and
  unlabelled. On a site whose claim is that it hides nothing, an unexplained gap in a count
  reads as filtering. Now the labels name all three buckets, and a build-time assertion fails
  the deploy if a partition ever exceeds its total.
- **A number-or-null helper must reject null before it coerces.** `Number(null)` is `0` and `0`
  passes `isFinite`, so a missing value silently becomes a real zero. This guard caught a fresh
  instance of that bug *during this audit cycle*, in code written minutes earlier.
- **Every internal link must point at a declared route.**
- **Every `.json` the app fetches must be in the sync list**, or it freezes silently.
- **The deploy and the scheduled sync must pull the same feeds.**

**358 UI assertions** (`test/ui.mjs`) run against the deployed site after every deploy, covering
every route at desktop and at 320×568. They gate the deploy — a red run blocks it.

**Ledger completeness.** Every published signal is in exactly one bucket, and zero-count buckets
are *printed rather than omitted*, because a missing "withdrawn" row is what looks like
filtering. The front page states the arithmetic — `45 published = 13 closed and graded + 32
still open + 0 withdrawn + 0 expired` — and says explicitly if they ever fail to sum.

---

## 9. Known limitations and open items

Stated because an audit that only lists strengths is not an audit.

| # | item | severity | status |
|---|---|---|---|
| 1 | Sample size: 13 closed trades cannot establish the *magnitude* of the edge, only its sign | high | inherent — needs 60–90 more closed signals |
| 2 | No engine clears the site's own bar (30 closed at t ≥ 2). Not one is close | high | disclosed on the site |
| 3 | The ₹1 crore paper book sizes 3 engines that have 3 closed trades between them, all losers | medium | **flagged, not resolved** — see below |
| 4 | Market data carries no vendor SLA; endpoints are undocumented and may be delayed or wrong | medium | disclosed on `/sources` and `/disclaimer` |
| 5 | No uptime monitoring, no synthetic checks, no front-end exception tracking | medium | open |
| 6 | The engines are written, measured and graded by one person | inherent | disclosed on `/disclosures` |
| 7 | Core Web Vitals not measured on the broadsheet route | low | open |
| 8 | Security headers pending deployment at time of writing | low | verify per §7 |

**On item 3.** Three published engines — LEDGE, KEEL, VECTOR — are sized by nothing. The
question of whether to add them was examined and answered **no**: the book's expectancy is
established as negative, so adding capacity increases exposure to a measured loss. But the
examination surfaced something sharper — the three engines *already* sized have three closed
trades between them, all losers, while the three unsized have ten. **The capital book is sized
on less evidence than it ignores.** The open question is therefore whether the three currently
sized belong there, which is a decision to *remove* capital and is the owner's to take.

---

## 10. What changed in this audit cycle

| finding | resolution |
|---|---|
| Published record counted 3 retired engines (65/12/8.3% vs true 45/11/9.1%) | One engine roster, shared by both sites, mirrored in Python, bound by a test |
| "Too few to settle anything" printed under a statistically significant loss | Verdict computed from the data: t, p and the 95% CI, in the hero and the record |
| Breadth arithmetic did not foot (160 + 818 ≠ 985) | Third bucket named; build-time reconciliation guard added |
| No SEBI disclosure anywhere a reader met before acting | Persistent bar in the static shell on both sites + 3 new pages |
| Every security header missing | 8 headers on every response, CSP with hashed inline scripts |
| Telegram `/performance` reported a different record from every page | Same population predicate as the site, verified identical |
| ₹1cr book funded the *retired* half of the TIDAL pair | Site retirement now binding on the capital book |
| Crawler snapshot claimed 65 published while the page said 45 | Prerender reads the shared roster |
| Stale screen price labelled "today" (TATACHEM −0.40% vs actual −11.04%) | One live-price map; unlabelled figures say "screen close" |
| Gems showed 5 open IPO books, signal showed 2 | IPO rule moved to the shared module; both now compute 2 |
| Section folds opened content 1,300px away from the click | CSS multicolumn replaced with explicit column elements |

---

## 11. How to re-run this audit

```bash
git clone https://github.com/caakshayk1-boop/signal && cd signal && npm install

node test/guard.mjs                      # 93 static guards
npx wrangler dev --port 8787             # local Worker
node test/ui.mjs http://127.0.0.1:8787   # 358 UI assertions
node test/ui.mjs https://signal.askakshay.com   # same suite, against production
```

Live checks that need nothing installed:

```bash
curl -sI https://signal.askakshay.com/                      # security headers
curl -s  https://signal.askakshay.com/api/signals?limit=400 # the full ledger
curl -s  https://signal.askakshay.com/api/health            # pipeline status
curl -s  https://signal.askakshay.com/robots.txt
curl -s  https://signal.askakshay.com/sitemap.xml
```

---

*Corrections to this document are welcome and are the point. If a figure here is wrong it is a
defect, not a difference of opinion — ca.akshayk1@gmail.com.*
