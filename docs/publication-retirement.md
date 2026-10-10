# Public publication retirement — 10 October 2026

Signal and Vision now expose market and company research. Engine, plan,
trial, performance, paper-book, wallet and digest pages are retired.

## Boundary

- `public/retirement.js` defines retired public page families and feed paths.
- `src/retirement.js` returns 410 before API routing or Static Assets access.
  Quotes (`/api/signals?px=…`) and price history (`?series=…`) remain available.
- Both browser routers honor the same page retirement, including hash links.
- Paper publication JSON, digest HTML/JSON/RSS and subscription intake return
  410. Historical files remain stored. Internal `env.ASSETS` reads still work.
- Company-page generation omits publication fields. Sitemaps omit retired
  pages, including when the internal digest builder runs after generation.
- The public regime response omits historical engine performance, preserving
  market state and regime history. The stored source file is unchanged.
- Both service workers have new cache versions, reject retired offline
  navigation and replace already-open old renderers once at activation.

No private engine repository, stored historical feed, database or job schedule
was removed. Authenticated delivery, watchdog and Telegram handlers remain.
Unsubscribe and existing preference-management endpoints remain available.

## Verification

Run `npm run build:publication`, `node test/guard.mjs`, `npm run test:unit`,
`npm run test:retirement`, and `npm run test:retirement:edge`.

The deterministic browser suite covers desktop/mobile research, company
detail, screening, menus, command palettes, returning-browser alerts, retired
deep links and a Gems market smoke. The edge suite starts real local Workers
with explicit `--local-upstream` values for both hostnames: current Wrangler
normalizes the inbound Host header without that option.

Old public-publication assertions are explicitly retired with reasons in
`test/guard.mjs`, `test/publication-html.mjs` and `test/ui.mjs`. Internal
analytics, delivery consent/idempotency, archive integrity and generic
market-data safety checks are retained.

After deployment check both `signal.askakshay.com` and `vision.askakshay.com`:

- `/` serves research; `/stock/TCS` on Signal and `/company/TCS` on Vision work.
- `/pulse`, `/compass`, `/magic`, `/wallet`, `/opportunities`, `/performance`,
  `/plan/old`, `/setup/old`, `/digests`, `/feed.xml`, `/digests/feed.xml`,
  `/signal_v2.json`, `/signal_trials.json`, `/paper_record.json`,
  `/magic_book.json`, `/technical_read.json` return 410 with `no-store`.
- Vision `/#/setups`, `/#/brief/TCS`, `/#/wallet` show the retirement notice.
- `/api/signals?wallet=1`, `/api/stats` and `/api/subscribe` return 410.
- `/api/signals?px=TCS`, `/api/signals?series=TCS&range=1y`, `/pulse.json`,
  `/screen-lite.json` and `/institutional.json` retain market functionality.
- `https://gems.askakshay.com/` retains its market and institutional sections.
