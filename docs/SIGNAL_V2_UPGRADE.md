# Signal v2 upgrade — implementation decisions

Scope: complete the supplied build brief in the existing Signal Worker and private vision-engine, preserving existing products and historical records.

## Architecture and boundaries
- Signal owns public rendering, API subscriptions, digest archives and delivery. The private engine owns research, execution and append-only trial state.
- Pulse and Compass publish a separate `signal-trials/1` feed. They do not mutate or retroactively enter the canonical main record.
- Existing delayed public data sources remain; unavailable fundamentals, delivery, earnings or restriction data block publication with named reasons.
- Essential current-session content must render in HTML before client hydration. A failed/stale feed is distinct from no qualifying setup.

## Execution decisions
- No same-close hindsight fills: Pulse close confirmation schedules entry at a later session open only if inside its published entry window.
- Daily-bar ambiguity is resolved conservatively, stop first; one-third exits at each Pulse target. Breakeven stop refers to entry price and costs remain charged.
- Pulse unfilled window is three sessions; eight-session active time stop starts at fill. Corporate-action ambiguities block or flag management rather than rewriting prices.
- Compass entries after publication execute at a later open; tranche two follows a five-percent pullback or twenty sessions, tranche three requires published quarterly confirmation.
- Both use versioned cost assumptions and fixed initial-risk denominators. Promotion thresholds trigger review only, never automatic promotion.

## Delivery and safety
- New subscriptions are pending until token confirmation; existing subscribers are not assumed to have double opted in.
- Unsubscribe takes effect immediately, tokens are opaque, provider retries use deterministic delivery keys.
- Digests and alerts describe completed-session simulated paper events, never real-time instructions.
- No arbitrary client payload may trigger bulk mail; build delivery endpoints require existing owner authorization.
- Existing nightly CI remains the publishing workflow. No new desktop Automation or OS cron substitutes are created.

## Acceptance and verification
- Homepage example is genuine closed forward data, genuine labelled trial data, or explicitly illustrative; empty history never becomes an invented success.
- Filterable setup table, net-R analytics with under-30 warning, trial journals, freshness labels, RSS/archive and canonicals.
- Synthetic no-lookahead and execution tests; subscription lifecycle and idempotency tests; existing guards and browser suite.
- Deploy via existing Cloudflare pipeline after checks. Report configured/tested separately from production delivery and forward qualification.
