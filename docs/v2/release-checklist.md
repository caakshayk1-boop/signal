# Signal V2 — route and copy checklist

Every row is checked by `test/guard.mjs` (static, before deploy) or
`test/ui.mjs` (rendered, after deploy) unless marked *manual*.

## Navigation

| Desktop | Phone tab bar | Route |
|---|---|---|
| Today | Today | `/` |
| Opportunities | Setups | `/opportunities` |
| Watchlist | Watchlist | `/watch` |
| Performance | Record | `/performance` |
| Market | More → Market | `/markets` |

## Routes

| Route | State on 1 Oct 2026 | Check |
|---|---|---|
| `/` | Headline *Indian equities, screened after the close.*; subheading *Review qualified setups, plan the next session, and track every paper trade.*; status strip; plans for the next session, or why there are none, in the feed's own terms (paused / not scanned / failed / none qualified) | guard + ui |
| `/opportunities` | Plans grouped by state; eligible first; extended plans named in words | guard |
| `/plan/:id` | Entry range, stop, T1–T3 with exit portions, R:R from the feed, stop and management rules, simulated fills, company research via the shared Business section | guard |
| `/performance` | *No completed sample yet*; win rate `—` below 30 closed; reconciliation line; *V2 forward record begins 1 Oct 2026. Previous model results are excluded.* | guard + ui |
| `/brief` | Redirects to a plan, or the empty state | guard |
| `/stock/:sym` | "Signal V2 plan" section; price label *Trading now · delayed* or *Last price · market closed* | manual (probe) |
| `/signals` `/engines` `/research` `/buoy` `/ideas` | Retired-version notice; no V1 call mapped onto a V2 plan | guard |
| `/api/signals` (ledger, `?wallet`), `/api/stats` | `410 Gone` with `successor: "/signal_v2.json"`; `?px` and `?series` stay | guard |
| `/privacy` | Lists `sig:watch`, `sig:alerts`, `sig.sizer.v1`, `sig:theme` | guard |
| Watchlist | Export and import JSON (`kind: signal-watchlist`), merging, never overwriting | guard |

## Status strip states

| Feed condition | Strip says |
|---|---|
| `status: ok / no_setups / market_filter / paused` | *scanned after the close* |
| `status: data_unavailable` | *not scanned — data incomplete* (warning colour) |
| `status: error` | *the last run failed — plans as of the last good run* (warning colour) |
| now > `next_scan_due` | **Overdue**, and which session the page is from |
| `calendar_verified: false` | *exchange calendar not yet confirmed* |

## Copy rules

- No probability, forecast, target price outside a plan, or "best stock of the day".
- No strategy internals (indicator names, thresholds, features, scores) in any V2 view.
- Absence is a word (`—`, *no completed sample*), never a zero rate.
- Fills are labelled *simulated*; no order is placed anywhere.

## Screenshots

Captured 1 Oct 2026 at 1280 px and 390 px, against the live feed (paused,
empty record) and a synthetic preview feed (symbols `DEMO*`, never
published). They are not committed. Regenerate them with the local harness:
`VDEV_SITE=signal node scripts/vision-dev.mjs 8792`.
